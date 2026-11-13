// Capture du son de l'onglet : conversion en PCM 16 bits mono à 16 kHz,
// par blocs de 100 ms. S'exécute dans le fil audio (AudioWorklet).

const TARGET_RATE = 16000;
const BLOCK = 1600; // 100 ms

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE; // 1 si le contexte est déjà à 16 kHz
    this.out = new Int16Array(BLOCK);
    this.n = 0;
    this.acc = 0; // somme des échantillons de la fenêtre de décimation
    this.accN = 0;
    this.phase = 0;
    this.peak = 0;
  }

  push(sample) {
    const a = Math.abs(sample);
    if (a > this.peak) this.peak = a;
    const s = Math.max(-1, Math.min(1, sample));
    this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.n === BLOCK) {
      const buf = this.out.buffer.slice(0);
      this.port.postMessage({ pcm: buf, peak: this.peak }, [buf]);
      this.n = 0;
      this.peak = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    const frames = input && input.length ? input[0].length : 128;
    const channels = input ? input.length : 0;
    for (let i = 0; i < frames; i++) {
      let v = 0;
      for (let c = 0; c < channels; c++) v += input[c][i];
      if (channels > 1) v /= channels;
      if (this.ratio === 1) {
        this.push(v);
        continue;
      }
      // Repli si le contexte n'est pas à 16 kHz : moyenne glissante (filtre
      // passe-bas sommaire) puis décimation.
      this.acc += v;
      this.accN++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        this.push(this.acc / this.accN);
        this.acc = 0;
        this.accN = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
