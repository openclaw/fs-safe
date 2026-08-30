// Synthetic USTAR fixtures compressed once with Python bz2 and Node zstd.
// No external compressor or native binding is needed to collect these tests.
export const compressedTarFraming = [
  {
    "name": "valid PAX/GNU payload and zero padding",
    "accepted": true,
    "tar-bzip2": "QlpoOTFBWSZTWbPXrCMAAMPfgd+QQAD/ggBFQcJu59/oAACJCDAAubYakAAAAAAABoCEjENA0AA0TQxNME0wSSpp6jQGmmjRtRoMgA0D1IX+u+w9ZqJSMZDHmXhEKzEhJT0D2kQ9Ewh7mdpFjReEkwImtBG3seOElEhhAqqqytyBJOIf1N0KtPAYQujXESJKDJIzmdEGQXaWKQPikdZpQAh1H5naQFqGpqI3Gi3d+6gyKiucMFQ26XZIQqNpkHv3oWEqHwRdgZZIIg4kaNQnItiQfxdyRThQkLPXrCM=",
    "tar-zstd": "KLUv/WABF8UFAGKHGBpwaXVELDuNvxheHE1fMV8LIEkT/hLE/nf/UpBRjuSYHCuUKv1giSUoTEvWtqWxzY8VSVU3Yx2AwWUXgsPb5iSKx5pUkR1bywZxC/7t9imgkWNNpX7/z9T/d6Dh2jMwh1gBICBwg6QkzQH+Ef7gOQV5gtUZo155PBgAZXpcZRRNMkAwAFPNbuSUJ6caAJvUgKnmdjjAMfREmVVgJgVGLYzggDGcCc2pA6aXFf9wBQfHXsYm4QU="
  },
  {
    "name": "hidden header after one zero block",
    "accepted": false,
    "tar-bzip2": "QlpoOTFBWSZTWeyfGFsAAFjbgMmAQABlgAAYZmXfIAjIIAB0EqmmEBo9QNGIyCSSD1BoAAAyvdfJYQmBKo2IlIWxTjiTAMWEAUBgQiLAcoYGIvAQaI4tCE5EYecTVWXzo+0WXlBlCrdiw/F3JFOFCQ7J8YWw",
    "tar-zstd": "KLUv/WAACw0DAJQDdmFsdWUAMDAwMDY0NDAwMDAwMDcAADAwNzAwMQAgMAB1c3RhcgAwcGF5bG9hZABoaWRkZW4AMDExDgD9QQXIgIoA4QGzYxVMpj6oGAJUEG9IDQDJgQhg0ADHymV2AkU="
  },
  {
    "name": "header after EOF",
    "accepted": false,
    "tar-bzip2": "QlpoOTFBWSZTWdRkUc0AAFzbgMmAQABlgAAYZmXfIAiYIAB0EqJhAD1A0YjIJRIMRkAMhoNcmp8Aq52ABcSIDwwgjxoAoCkRgIwWChEYA9Y0MBl4g4R5YEJyIw84musvnx9owuKDaFXbAr8XckU4UJDUZFHN",
    "tar-zstd": "KLUv/WAADRUDAJQDdmFsdWUAMDAwMDY0NDAwMDAwMDcAADAwNzAwMQAgMAB1c3RhcgAwcGF5bG9hZABoaWRkZW4AMDExDgD9QQXIgIoA4QFAxyqYTH3gZwhQQbwhNQAkByKAQQMcK5fZCRQB"
  },
  {
    "name": "nonzero byte after EOF",
    "accepted": false,
    "tar-bzip2": "QlpoOTFBWSZTWb5wTi4AADJbgOmAQABlgAAIZgTfIAgYIABUUnpoEwmANNQSU1Bpo009QAaaRKoe0QY8TkUnKKCrA1GE0BDsF8LFg9jiCMFzei6BGAmJmuKU/i7kinChIXzgnFw=",
    "tar-zstd": "KLUv/WABB10CAAQDdmFsdWUAMDAwMDY0NDAwMDAwMDcAADAwNzAwMQAgMAB1c3RhcgAwcGF5bG9hZAABCQD1gZ8hQAXxhtQAkByIAAYNcKxcZidQBA=="
  },
  {
    "name": "missing second EOF block",
    "accepted": false,
    "tar-bzip2": "QlpoOTFBWSZTWScMGI4AAC3bgMmAQABlgAAIZgTfIAhIIABUUGgAANNAkiINNHqAARafLOYlTet5lWlyTA2LidhEOFjSV0Sibmw83oepEkgQF5cjm+LuSKcKEgThgxHA",
    "tar-zstd": "KLUv/WAABVUCAPQCdmFsdWUAMDAwMDY0NDAwMDAwMDcAADAwNzAwMQAgMAB1c3RhcgAwcGF5bG9hZAAJAPVBxRCggnhDagBIDkQAgwY4Vi6zEygC"
  },
  {
    "name": "type 1 body/header smuggling",
    "accepted": false,
    "tar-bzip2": "QlpoOTFBWSZTWV2llTwAAHPbgMmAQAJ1gABYZ2XfIAgYIAByGlAyAAANqfqm1BtKKeo8p6mhsiAyAt1amL8LKSAqsPIyiOfCjGbgGkMrgoglEaSVGBje8kijUntgPfCGydbMlcmWioI8EeovUN1Il8iS+NQN7WrW5LkZKArB0H7IB+LuSKcKEgu0sqeA",
    "tar-zstd": "KLUv/WAAC60DAFLEDhaQtekAkMzPN4CH55qZ9aw9vwXV/yXKJ5kKpPGm9O7ML3ROKr5HJkhr21QCrhQF/O79iMN/kUpEsNgKFACZ5X6gYDJkQEWAMHAsmBVp8IEC4nKlBuYbIJqwYCoBUgicYNOYPO2YUZyFm8YFOFYugxM4Ag=="
  },
  {
    "name": "type 2 body/header smuggling",
    "accepted": false,
    "tar-bzip2": "QlpoOTFBWSZTWSohKygAAHPbgMmAQAJ3gABYZ2XfIAgYIAByGlAyAAGmmnpPU2oNpSZGmUaDajQNAM+jUxfhcpICqy8G4ojhtoxkwGkM2ZK4ErhpJUYHG1pJGLUnfAdIQjXFkbFpmcVBHdB6UezdFBP5JEbKwJit52sLAlKoGoY5vBAfi7kinChIFRCVlAA=",
    "tar-zstd": "KLUv/WAAC7UDAFIEDxaANeoA0f/4LH//+aIouYZh8hojRpTJKR0LpPGoFBHRN5XSKr5HJshr+1gCTKlgznjxP2f4r2KLCJprARQAmeV+oGAyZEBFgDBwLJgVafCBAuJypQbmGyCasGAqAVIInGDTmDztmFGchZvGBThWLoMTOAI="
  },
  {
    "name": "type 5 body/header smuggling",
    "accepted": false,
    "tar-bzip2": "QlpoOTFBWSZTWVElGPAAAHLbgMmAQAL3gACYZ2XfIAgYIAByK9UHqGjIGgMmh6m1BFKm0TTynqNB6gAAw52rNPycM4rU1d3J0jt1zhhxVgGGtciShJgApCu61rwZw3phSJbKtm6l2Lv0OYe3v0PId8H7PGRnXJcL0ujbUGhASAicFK/F3JFOFCQUSUY8AA==",
    "tar-zstd": "KLUv/WAAC20DAGKEDxeANeoAscXP09z3/Yui5ApW/v7hgBkdMikdGyTyqOqxFFyKiG0qpXX0m2QA8HpKiWPQF39jiv8Oii1DaK4FEQCZgR8omAwZUBEgrIMUggEVAC4IbIBogoLJzAF1AEjHrbgZX4Bj5TI3ASQ="
  }
] as const;
