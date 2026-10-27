#pragma once
#include <stdint.h>
#include <string.h>
namespace ensaia_cloud {
constexpr unsigned SAMPLE_RATE=16000, SAMPLES=320, HEADER=24, PACKET=664;
inline int16_t pcm16(int32_t raw,int gain){int64_t n=static_cast<int64_t>(raw>>16)*gain;if(n>32767)n=32767;if(n<-32768)n=-32768;return static_cast<int16_t>(n);}
inline void put32(uint8_t* p,uint32_t n){for(int i=0;i<4;i++)p[i]=(n>>(i*8))&255;}
inline void header(uint8_t* p,const char* sid,uint32_t seq){memcpy(p,sid,16);put32(p+16,seq);put32(p+20,seq*SAMPLES);}
}
