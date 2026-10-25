// In-place radix-2 FFT. Inverse includes normalization; no platform or model dependency.
export function fft(re, im, inverse = false) {
  const n = re.length;
  if (im.length !== n || n < 2 || n & (n - 1)) throw Error("Invalid FFT size");
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const r = re[i],
        q = im[i];
      re[i] = re[j];
      im[i] = im[j];
      re[j] = r;
      im[j] = q;
    }
  }
  for (let width = 2; width <= n; width *= 2) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / width;
    const wr = Math.cos(angle),
      wi = Math.sin(angle);
    for (let start = 0; start < n; start += width) {
      let xr = 1,
        xi = 0;
      for (let j = 0; j < width / 2; j++) {
        const a = start + j,
          b = a + width / 2;
        const br = re[b] * xr - im[b] * xi,
          bi = re[b] * xi + im[b] * xr;
        re[b] = re[a] - br;
        im[b] = im[a] - bi;
        re[a] += br;
        im[a] += bi;
        const next = xr * wr - xi * wi;
        xi = xr * wi + xi * wr;
        xr = next;
      }
    }
  }
  if (inverse)
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
}
export function fftSize(n) {
  let size = 2;
  while (size < n) size *= 2;
  return size;
}
