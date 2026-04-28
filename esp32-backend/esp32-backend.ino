#include <Arduino.h>

#define AUDIO_PIN 23
#define FREQ 80_000
#define BITS 16

void setup() {
  Serial.begin(115200);
  delay(1000);
  ledcAttach(AUDIO_PIN, FREQ, BITS); 
  Serial.println("\n--- STARTING ---");
}

void loop() {
  uint32_t range = (1 << BITS) - 1;
  for (uint32_t i = 0; i <= range; i += 10) {
    ledcWrite(AUDIO_PIN, i); 
    delay(100);
  }
}