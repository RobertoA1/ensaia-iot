#pragma once
#include <stdint.h>
#include <string.h>

namespace ensaia {
constexpr unsigned SAMPLES = 320;
constexpr unsigned RATE = 16000;
constexpr unsigned HEADER_BYTES = 16;
constexpr unsigned PACKET_BYTES = HEADER_BYTES + SAMPLES * 2;

inline int16_t pcm16(int32_t leftAligned24, int gain) {
  // INMP441: 24 bits con signo, alineados al MSB de una ranura I2S de 32 bits.
  int64_t value = static_cast<int64_t>(leftAligned24 >> 16) * gain;
  if (value > 32767) value = 32767;
  if (value < -32768) value = -32768;
  return static_cast<int16_t>(value);
}
inline void put32(uint8_t* p, uint32_t value) {
  for (unsigned i = 0; i < 4; ++i) p[i] = (value >> (8 * i)) & 0xff;
}
inline void header(uint8_t* p, const char* sid, uint32_t seq) {
  memcpy(p, sid, 8);
  put32(p + 8, seq);
  put32(p + 12, seq * SAMPLES);
}
inline void sample(uint8_t* p, int16_t value) {
  const uint16_t bits = static_cast<uint16_t>(value);
  p[0] = bits & 0xff;
  p[1] = bits >> 8;
}
}
