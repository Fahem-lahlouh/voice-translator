"""Serveur WebSocket local, réservé à l'extension.

Protections :
* écoute uniquement sur 127.0.0.1 ;
* l'en-tête Origin doit être celui de l'extension autorisée : une page web
  quelconque (https://…) ou une autre extension est refusée avant même
  l'ouverture du WebSocket ;
* l'en-tête Host doit désigner la boucle locale (anti « DNS rebinding ») ;
* jeton partagé facultatif ;
* chaque message est validé (type, taille, champs) ; un message invalide
  ferme la connexion ;
* une seule session active à la fois.
"""

from __future__ import annotations

import asyncio
import hmac
import http
import json
import logging
import struct
import time
from typing import Optional

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from . import PROTOCOL_VERSION, __version__
from .config import Config
from .engines import VOICES, Engines
from .pipeline import CONTENT_MODES, SUPPORTED_PAIRS, Session, parse_settings
from .summarizer import LLM_MODELS, Cancelled, Summarizer

log = logging.getLogger("vt.server")

MAX_MESSAGE_BYTES = 4 * 1024 * 1024  # une transcription de plusieurs heures tient dans un message
MAX_AUDIO_SAMPLES = 16000 * 2  # 2 s par trame au maximum
MAX_TEST_TEXT = 300
CLOSE_POLICY = 1008
CLOSE_REPLACED = 4001

DEFAULT_TEST_SENTENCE = (
    "Bonjour ! Voici la voix française qui lira la traduction de votre formation."
)


class ProtocolError(Exception):
    pass


def _int(msg: dict, key: str, lo: int = 0, hi: int = 2**31 - 1) -> int:
    v = msg.get(key)
    if not isinstance(v, int) or isinstance(v, bool) or not (lo <= v <= hi):
        raise ProtocolError(f"champ « {key} » invalide")
    return v


class LocalServer:
    def __init__(self, cfg: Config, engines: Engines):
        self.cfg = cfg
        self.engines = engines
        self._active: Optional[ServerConnection] = None
        # Résumés : modèle de langage chargé seulement à la demande.
        self.summarizer = Summarizer(cfg.models_dir, threads=max(1, cfg.cpu_threads))
        self._allowed_origins = cfg.allowed_origins()
        self._allowed_hosts = {
            f"127.0.0.1:{cfg.port}", f"localhost:{cfg.port}", f"[::1]:{cfg.port}",
        }

    # ------------------------------------------------- filtrage des connexions
    def process_request(self, connection: ServerConnection, request):
        headers = request.headers
        host = headers.get("Host", "")
        if host not in self._allowed_hosts:
            log.warning("Connexion refusée : en-tête Host inattendu (%r)", host)
            return connection.respond(http.HTTPStatus.FORBIDDEN, "Hôte refusé.\n")
        path = request.path.split("?", 1)[0]
        origin = headers.get("Origin")
        if path == "/health":
            # Réponse minimale, sans information sur la machine ni sur l'activité.
            # La page d'options de l'extension l'interroge en HTTP simple : il
            # lui faut l'en-tête CORS, accordé à la seule extension autorisée.
            response = connection.respond(http.HTTPStatus.OK, "voice-translator: ok\n")
            if origin in self._allowed_origins:
                response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Cache-Control"] = "no-store"
            return response
        if path != "/ws":
            return connection.respond(http.HTTPStatus.NOT_FOUND, "Introuvable.\n")
        if origin not in self._allowed_origins:
            log.warning("Connexion refusée : origine non autorisée (%r)", origin)
            return connection.respond(http.HTTPStatus.FORBIDDEN, "Origine refusée.\n")
        return None

    # ------------------------------------------------------------- connexion
    async def handler(self, ws: ServerConnection) -> None:
        loop = asyncio.get_running_loop()
        outbox: asyncio.Queue = asyncio.Queue(maxsize=400)

        def _put(item) -> None:
            try:
                outbox.put_nowait(item)
            except asyncio.QueueFull:
                # Client trop lent : on sacrifie les mesures, jamais l'audio.
                if isinstance(item, str) and '"type": "metrics"' in item:
                    return
                log.error("File d'envoi saturée : fermeture de la connexion")
                loop.create_task(ws.close(1011, "file d'envoi saturée"))

        def send_json(obj: dict) -> None:
            loop.call_soon_threadsafe(_put, json.dumps(obj, ensure_ascii=False))

        def send_binary(data: bytes) -> None:
            loop.call_soon_threadsafe(_put, data)

        async def sender() -> None:
            while True:
                item = await outbox.get()
                await ws.send(item)

        def on_engine_status(snap: dict) -> None:
            send_json({"type": "status", **snap})

        session: Optional[Session] = None
        sender_task = asyncio.create_task(sender())
        try:
            # 1) Poignée de main obligatoire.
            try:
                first = await asyncio.wait_for(ws.recv(), timeout=5)
            except asyncio.TimeoutError:
                await ws.close(CLOSE_POLICY, "poignée de main attendue")
                return
            hello = self._parse_json(first)
            if hello.get("type") != "hello" or hello.get("protocol") != PROTOCOL_VERSION:
                await ws.close(CLOSE_POLICY, "protocole incompatible")
                return
            if self.cfg.auth_token:
                token = hello.get("token")
                if not isinstance(token, str) or not hmac.compare_digest(
                        token.encode(), self.cfg.auth_token.encode()):
                    log.warning("Connexion refusée : jeton incorrect")
                    await ws.close(CLOSE_POLICY, "jeton incorrect")
                    return

            role = hello.get("role", "doublage")
            if role == "outil":
                # Connexion d'un outil (bibliothèque) : ne remplace pas la
                # session de doublage en cours.
                await self._tool_loop(ws, send_json)
                return
            if role != "doublage":
                await ws.close(CLOSE_POLICY, "rôle inconnu")
                return

            # 2) Une seule session : la nouvelle remplace l'ancienne.
            previous, self._active = self._active, ws
            if previous is not None:
                await previous.close(CLOSE_REPLACED, "remplacé par une nouvelle session")

            session = Session(self.engines, self.cfg, send_json, send_binary)
            self.engines.subscribe(on_engine_status)
            send_json({
                "type": "hello_ok",
                "version": __version__,
                "protocol": PROTOCOL_VERSION,
                "profile": self.cfg.profile,
                "asrModel": self.cfg.asr_model,
                "mtModel": self.cfg.mt_model,
                "device": self.cfg.device,
                "pairs": [list(p) for p in sorted(SUPPORTED_PAIRS)],
                "voices": self.engines.speaker.available(),
                "defaultVoice": self.cfg.default_voice,
            })
            send_json({"type": "status", **self.engines.snapshot()})
            log.info("Extension connectée")

            # 3) Boucle des messages.
            async for message in ws:
                if isinstance(message, (bytes, bytearray)):
                    self._on_audio(session, bytes(message))
                else:
                    self._on_json(session, self._parse_json(message), send_json)
        except ProtocolError as exc:
            log.warning("Message invalide : %s", exc)
            try:
                await ws.close(CLOSE_POLICY, f"message invalide : {exc}"[:120])
            except Exception:
                pass
        except ConnectionClosed:
            pass
        finally:
            self.engines.unsubscribe(on_engine_status)
            if session is not None:
                session.close()
                log.info("Extension déconnectée — %s", _stats_line(session.stats))
            if self._active is ws:
                self._active = None
            sender_task.cancel()

    # ------------------------------------------------------------- outils
    async def _tool_loop(self, ws: ServerConnection, send_json) -> None:
        loop = asyncio.get_running_loop()
        send_json({"type": "hello_ok", "role": "outil", "version": __version__, "llm": self.summarizer.status()})
        busy = False
        async for message in ws:
            if not isinstance(message, str):
                raise ProtocolError("message texte attendu")
            msg = self._parse_json(message)
            kind = msg["type"]
            req_id = msg.get("requestId", "")
            if not isinstance(req_id, str) or len(req_id) > 100:
                raise ProtocolError("identifiant de requête invalide")
            if kind == "llm_status":
                send_json({"type": "llm_status", "requestId": req_id, "llm": self.summarizer.status()})
            elif kind == "cancel":
                self.summarizer.cancel()
            elif kind in ("llm_download", "summarize"):
                if busy:
                    send_json({"type": "error", "requestId": req_id, "message": "Une opération est déjà en cours."})
                    continue
                model = msg.get("model", "llama3.2-3b")
                if model not in LLM_MODELS:
                    raise ProtocolError("modèle de résumé inconnu")
                if kind == "llm_download":
                    job = self._download_job(model, req_id, send_json)
                else:
                    job = self._summary_job(msg, model, req_id, send_json)
                busy = True

                async def run(job=job):
                    nonlocal busy
                    try:
                        await loop.run_in_executor(None, job)
                    finally:
                        busy = False

                asyncio.ensure_future(run())
            else:
                raise ProtocolError(f"type de message inconnu : {kind[:40]}")

    def _download_job(self, model: str, req_id: str, send_json):
        def job():
            last = [0.0]

            def progress(done, total):
                now = time.monotonic()
                if now - last[0] > 0.5 or done == total:
                    last[0] = now
                    send_json({"type": "llm_download", "requestId": req_id, "model": model,
                               "done": done, "total": total})
            try:
                self.summarizer.download(model, progress)
                send_json({"type": "llm_status", "requestId": req_id, "llm": self.summarizer.status()})
            except Exception as exc:
                log.exception("Téléchargement du modèle de résumé impossible")
                send_json({"type": "error", "requestId": req_id, "message": f"Téléchargement impossible : {exc}"})
        return job

    @staticmethod
    def _valid_segments(raw) -> list:
        if not isinstance(raw, list) or not raw or len(raw) > 30000:
            raise ProtocolError("transcription invalide")
        out = []
        for s in raw:
            if not isinstance(s, dict):
                raise ProtocolError("phrase invalide")
            start, end, en = s.get("start"), s.get("end"), s.get("en")
            if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (start, end)):
                raise ProtocolError("horodatage invalide")
            if not isinstance(en, str) or len(en) > 4000:
                raise ProtocolError("texte de phrase invalide")
            if en.strip():
                out.append({"start": float(start), "end": float(end), "en": en.strip()})
        if not out:
            raise ProtocolError("transcription vide")
        return sorted(out, key=lambda x: x["start"])

    def _summary_job(self, msg: dict, model: str, req_id: str, send_json):
        segments = self._valid_segments(msg.get("segments"))
        mode = msg.get("mode", "auto")
        if mode not in CONTENT_MODES:
            raise ProtocolError("type de contenu inconnu")
        with_sheet = msg.get("withSheet", False)
        if not isinstance(with_sheet, bool):
            raise ProtocolError("withSheet : booléen attendu")

        def job():
            def progress(frac, step):
                send_json({"type": "summary_progress", "requestId": req_id, "progress": round(frac, 3), "step": step})
            try:
                result = self.summarizer.summarize(segments, mode, model, with_sheet, progress)
                send_json({"type": "summary_result", "requestId": req_id, "result": result})
            except Cancelled:
                send_json({"type": "summary_cancelled", "requestId": req_id})
            except Exception as exc:
                log.exception("Résumé impossible")
                send_json({"type": "error", "requestId": req_id, "message": f"Résumé impossible : {exc}"})
        return job

    # --------------------------------------------------------------- messages
    @staticmethod
    def _parse_json(message) -> dict:
        if not isinstance(message, str):
            raise ProtocolError("message texte attendu")
        if len(message) > MAX_MESSAGE_BYTES:
            raise ProtocolError("message trop volumineux")
        try:
            obj = json.loads(message)
        except json.JSONDecodeError as exc:
            raise ProtocolError("JSON invalide") from exc
        if not isinstance(obj, dict) or not isinstance(obj.get("type"), str):
            raise ProtocolError("objet avec champ « type » attendu")
        return obj

    @staticmethod
    def _on_audio(session: Session, data: bytes) -> None:
        if len(data) < 4 or (len(data) - 4) % 2:
            raise ProtocolError("trame audio mal formée")
        if (len(data) - 4) // 2 > MAX_AUDIO_SAMPLES:
            raise ProtocolError("trame audio trop longue")
        (epoch,) = struct.unpack_from("<I", data, 0)
        session.feed(epoch, data[4:])

    def _on_json(self, session: Session, msg: dict, send_json) -> None:
        kind = msg["type"]
        try:
            if kind == "start":
                settings = parse_settings(msg.get("settings", {}))
                session.start(_int(msg, "epoch"), settings)
                send_json({"type": "started", "epoch": session.epoch})
            elif kind == "settings":
                session.update_settings(parse_settings(msg.get("settings", {}), session.settings))
            elif kind == "reset":
                session.reset(_int(msg, "epoch"))
                send_json({"type": "reset_ok", "epoch": session.epoch})
            elif kind == "stop":
                session.stop()
                send_json({"type": "stopped", "stats": session.stats})
            elif kind == "playback":
                q = msg.get("queue")
                if not isinstance(q, (int, float)) or isinstance(q, bool):
                    raise ProtocolError("champ « queue » invalide")
                session.playback_report(float(q))
            elif kind == "tts_test":
                voice = msg.get("voice", self.cfg.default_voice)
                rate = msg.get("rate", 1.0)
                text = msg.get("text") or DEFAULT_TEST_SENTENCE
                if voice not in VOICES:
                    raise ProtocolError("voix inconnue")
                if not isinstance(rate, (int, float)) or isinstance(rate, bool) or not 0.6 <= rate <= 1.8:
                    raise ProtocolError("vitesse invalide")
                if not isinstance(text, str) or len(text) > MAX_TEST_TEXT:
                    raise ProtocolError("texte de test invalide")
                session.voice_test(voice, float(rate), text)
            elif kind == "tts_fit":
                seg_id, text = msg.get("id"), msg.get("text")
                voice = msg.get("voice", self.cfg.default_voice)
                rate, max_dur = msg.get("rate", 1.0), msg.get("maxDuration")
                if not isinstance(seg_id, str) or not 0 < len(seg_id) <= 200:
                    raise ProtocolError("identifiant de phrase invalide")
                if not isinstance(text, str) or not 0 < len(text) <= 1000:
                    raise ProtocolError("texte invalide")
                if voice not in VOICES:
                    raise ProtocolError("voix inconnue")
                for v, lo, hi in ((rate, 0.5, 2.0), (max_dur, 0.2, 120.0)):
                    if not isinstance(v, (int, float)) or isinstance(v, bool) or not lo <= v <= hi:
                        raise ProtocolError("vitesse ou durée invalide")
                session.prepare_voice(seg_id, text, voice, float(rate), float(max_dur))
            elif kind == "ping":
                send_json({"type": "pong", "t": msg.get("t")})
            else:
                raise ProtocolError(f"type de message inconnu : {kind[:40]}")
        except ValueError as exc:
            # Réglage refusé : on le signale sans couper la session.
            send_json({"type": "error", "code": "reglages", "message": str(exc)})

    # ------------------------------------------------------------------ cycle
    async def run(self, stop_event: Optional[asyncio.Event] = None) -> None:
        async with serve(
            self.handler,
            self.cfg.host,
            self.cfg.port,
            process_request=self.process_request,
            max_size=MAX_MESSAGE_BYTES,
            max_queue=64,
            ping_interval=20,
            ping_timeout=30,
            compression=None,  # boucle locale : la compression ne ferait que consommer du CPU
            server_header=None,
        ):
            log.info("Serveur à l'écoute sur ws://%s:%d/ws (boucle locale uniquement)",
                     self.cfg.host, self.cfg.port)
            if stop_event is None:
                await asyncio.get_running_loop().create_future()
            else:
                await stop_event.wait()


def _stats_line(st: dict) -> str:
    return (f"{st['segments']} segments, {st['abandonnes']} abandonnés, "
            f"{st['incertains']} incertains, audio {st['audio_s']:.0f}s, "
            f"ASR {st['asr_s']:.1f}s, MT {st['mt_s']:.1f}s, TTS {st['tts_s']:.1f}s")
