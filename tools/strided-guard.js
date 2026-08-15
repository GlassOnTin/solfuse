// Wrap cv.Mat's `data`/`data32F` getters and report any read from a Mat whose
// rows are not contiguous. That is the exact condition under which the
// accessor silently returns the wrong bytes.
module.exports = function guard(cv) {
  const hits = new Map();
  for (const prop of ['data', 'data32F', 'data8U', 'data64F', 'data16U', 'data32S']) {
    const d = Object.getOwnPropertyDescriptor(cv.Mat.prototype, prop);
    if (!d || !d.get) continue;
    const orig = d.get;
    Object.defineProperty(cv.Mat.prototype, prop, {
      configurable: true,
      get() {
        try {
          const rowBytes = this.cols * this.elemSize();
          const step0 = Array.isArray(this.step) ? this.step[0] : this.step;
          if (this.rows > 1 && (!this.isContinuous() || step0 !== rowBytes)) {
            const where = new Error().stack.split('\n')[2] || '?';
            const key = `${prop} ${this.rows}x${this.cols} step=${step0} rowBytes=${rowBytes} @${where.trim()}`;
            hits.set(key, (hits.get(key) || 0) + 1);
          }
        } catch (e) { /* header not readable; nothing to judge */ }
        return orig.call(this);
      },
    });
  }
  return hits;
};
