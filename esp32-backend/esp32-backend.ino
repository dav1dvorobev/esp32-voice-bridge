#include <Arduino.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_timer.h>

#define AUDIO_PIN 23

static const char *WIFI_SSID = "";
static const char *WIFI_PASSWORD = "";

static const uint16_t HTTP_PORT = 80;
static const uint32_t SAMPLE_RATE_HZ = 8000;
static const uint32_t SAMPLE_PERIOD_US = 1000000 / SAMPLE_RATE_HZ;
static const uint32_t PWM_FREQ_HZ = 78125;
static const uint8_t PWM_BITS = 10;
static const uint32_t PWM_CENTER_DUTY = 1UL << (PWM_BITS - 1);
static const uint16_t PWM_CHANNEL = 0;
static const size_t MAX_AUDIO_BYTES = 200000;
static const uint32_t WIFI_RETRY_DELAY_MS = 500;

WebServer server(HTTP_PORT);

static uint8_t *audioBuffer = nullptr;
static size_t audioLength = 0;
static size_t audioExpectedLength = 0;
static bool audioReadFailed = false;

static void pwmAttach() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(AUDIO_PIN, PWM_FREQ_HZ, PWM_BITS);
#else
  ledcSetup(PWM_CHANNEL, PWM_FREQ_HZ, PWM_BITS);
  ledcAttachPin(AUDIO_PIN, PWM_CHANNEL);
#endif
}

static void pwmWrite(uint32_t duty) {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(AUDIO_PIN, duty);
#else
  ledcWrite(PWM_CHANNEL, duty);
#endif
}

static void addCorsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
}

static void sendText(int status, const char *body) {
  addCorsHeaders();
  server.send(status, "text/plain; charset=utf-8", body);
}

static void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("Connecting to Wi-Fi: %s", WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) {
    delay(WIFI_RETRY_DELAY_MS);
    Serial.print(".");
  }
  Serial.println();
  Serial.println("Wi-Fi connected");
  Serial.printf("IP address: %s\n", WiFi.localIP().toString().c_str());
}

static void playPcm16Mono(const uint8_t *audio, size_t length) {
  uint64_t nextTick = esp_timer_get_time();
  for (size_t offset = 0; offset + 1 < length; offset += 2) {
    uint16_t raw = static_cast<uint16_t>(audio[offset]) |
                   (static_cast<uint16_t>(audio[offset + 1]) << 8);
    int16_t sample = static_cast<int16_t>(raw);
    uint32_t unsignedSample =
        static_cast<uint32_t>(static_cast<int32_t>(sample) + 32768);
    uint32_t duty = unsignedSample >> (16 - PWM_BITS);
    pwmWrite(duty);
    nextTick += SAMPLE_PERIOD_US;
    while (static_cast<int64_t>(esp_timer_get_time() - nextTick) < 0) {
      delayMicroseconds(5);
    }
  }
  pwmWrite(PWM_CENTER_DUTY);
}

static bool hasExpectedContentType() {
  String contentType = server.header("Content-Type");
  contentType.toLowerCase();
  return contentType.length() == 0 ||
         contentType.startsWith("application/octet-stream");
}

static void handleAudioOptions() {
  addCorsHeaders();
  server.sendHeader("Access-Control-Max-Age", "86400");
  server.send(204);
}

static void resetAudioBuffer() {
  if (audioBuffer != nullptr) {
    free(audioBuffer);
  }
  audioBuffer = nullptr;
  audioLength = 0;
  audioExpectedLength = 0;
  audioReadFailed = false;
}

static void handleAudioRaw() {
  HTTPRaw &raw = server.raw();
  if (raw.status == RAW_START) {
    resetAudioBuffer();
    int contentLength = server.clientContentLength();
    if (contentLength <= 0 ||
        static_cast<size_t>(contentLength) > MAX_AUDIO_BYTES) {
      audioReadFailed = true;
      return;
    }
    audioExpectedLength = static_cast<size_t>(contentLength);
    audioBuffer = static_cast<uint8_t *>(malloc(audioExpectedLength));
    if (audioBuffer == nullptr) {
      audioReadFailed = true;
    }
    return;
  }
  if (raw.status == RAW_WRITE) {
    if (audioReadFailed || audioBuffer == nullptr) {
      return;
    }
    if (audioLength + raw.currentSize > audioExpectedLength) {
      audioReadFailed = true;
      return;
    }
    memcpy(audioBuffer + audioLength, raw.buf, raw.currentSize);
    audioLength += raw.currentSize;
    return;
  }
  if (raw.status == RAW_ABORTED) {
    audioReadFailed = true;
  }
}

static void handleAudioPost() {
  if (!hasExpectedContentType()) {
    resetAudioBuffer();
    sendText(415, "expected application/octet-stream\n");
    return;
  }
  if (audioReadFailed) {
    resetAudioBuffer();
    sendText(400, "failed to read audio body\n");
    return;
  }
  if (audioBuffer == nullptr || audioLength == 0) {
    resetAudioBuffer();
    sendText(400, "missing audio body\n");
    return;
  }
  if (audioLength != audioExpectedLength) {
    resetAudioBuffer();
    sendText(400, "incomplete audio body\n");
    return;
  }
  if ((audioLength % 2) != 0) {
    resetAudioBuffer();
    sendText(400, "pcm body must contain int16 samples\n");
    return;
  }
  if (audioLength > MAX_AUDIO_BYTES) {
    resetAudioBuffer();
    sendText(413, "audio body is too large\n");
    return;
  }
  sendText(200, "playing\n");
  Serial.printf("Playing %u bytes of PCM audio\n",
                static_cast<unsigned>(audioLength));
  playPcm16Mono(audioBuffer, audioLength);
  resetAudioBuffer();
  Serial.println("Playback finished");
}

static void handleNotFound() { sendText(404, "not found\n"); }

void setup() {
  Serial.begin(115200);
  delay(1000);

  pwmAttach();
  pwmWrite(PWM_CENTER_DUTY);

  Serial.println();
  Serial.println("--- ESP32 Voice Bridge ---");
  connectWifi();

  const char *headers[] = {"Content-Type"};
  server.collectHeaders(headers, 1);
  server.on("/audio", HTTP_OPTIONS, handleAudioOptions);
  server.on("/audio", HTTP_POST, handleAudioPost, handleAudioRaw);
  server.onNotFound(handleNotFound);
  server.begin();
}

void loop() { server.handleClient(); }
