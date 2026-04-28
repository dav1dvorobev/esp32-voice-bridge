const OUTPUT_SAMPLE_RATE = 8000;
const MAX_RECORDING_MS = 10000;
const MIN_RECORDING_MS = 180;
const BUTTON_RELEASE_ANIMATION_MS = 350;
const TARGET_PEAK = 0.92;
const MAX_AUTO_GAIN = 8;

const elements = {
    address: document.getElementById("esp32Address"),
    button: document.getElementById("voiceButton"),
    shell: document.getElementById("voiceShell"),
};

let recorder = null;
let isSending = false;
let feedbackTimer = null;

init();

function init() {
    elements.button.addEventListener("pointerdown", handleHoldStart);
    elements.button.addEventListener("pointerup", handleHoldEnd);
    elements.button.addEventListener("pointerleave", handleHoldEnd);
    elements.button.addEventListener("pointercancel", handleHoldEnd);
    elements.address.addEventListener("change", handleAddressChange);
}

async function handleHoldStart(event) {
    event.preventDefault();
    if (recorder || isSending) {
        return;
    }
    try {
        recorder = await startRecorder();
        elements.button.classList.add("is-holding");
        elements.button.setPointerCapture?.(event.pointerId);
    } catch (error) {
        recorder = null;
        showFeedback("error");
    }
}

async function handleHoldEnd(event) {
    event.preventDefault();
    await stopRecording(event.pointerId);
}

function handleAddressChange() {
    try {
        getAudioUrl();
    } catch (error) {
        showFeedback("error");
    }
}

async function stopRecording(pointerId = null) {
    elements.button.classList.remove("is-holding");
    releasePointer(pointerId);
    const releasedAt = performance.now();
    if (!recorder) {
        return;
    }
    const currentRecorder = recorder;
    recorder = null;
    const recording = await currentRecorder.stop();
    if (recording.durationMs < MIN_RECORDING_MS) {
        return;
    }
    try {
        isSending = true;
        await sendAudio(
            encodePcm16Mono(recording.samples, recording.sampleRate),
        );
        await waitForReleaseAnimation(releasedAt);
        showFeedback("ok");
    } catch (error) {
        await waitForReleaseAnimation(releasedAt);
        showFeedback("error");
    } finally {
        isSending = false;
    }
}

async function startRecorder() {
    assertMicrophoneApiAvailable();
    const stream = await openMicrophone();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    const startedAt = performance.now();
    const autoStopTimer = window.setTimeout(() => {
        void stopRecording();
    }, MAX_RECORDING_MS);
    processor.onaudioprocess = (event) => {
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(context.destination);
    return {
        async stop() {
            window.clearTimeout(autoStopTimer);
            processor.disconnect();
            source.disconnect();
            stream.getTracks().forEach((track) => track.stop());
            await context.close();
            return {
                samples: mergeChunks(chunks),
                sampleRate: context.sampleRate,
                durationMs: performance.now() - startedAt,
            };
        },
    };
}

async function openMicrophone() {
    try {
        return await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
            video: false,
        });
    } catch (error) {
        throw new Error(getMicrophoneErrorMessage(error));
    }
}

function assertMicrophoneApiAvailable() {
    if (window.isSecureContext === false) {
        throw new Error("Для микрофона нужен HTTPS или localhost");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("В этом браузере недоступен MediaDevices API");
    }
}

function getMicrophoneErrorMessage(error) {
    switch (error?.name) {
        case "NotAllowedError":
        case "SecurityError":
            return "Доступ к микрофону запрещен в браузере";
        case "NotFoundError":
            return "Микрофон не найден";
        case "NotReadableError":
            return "Микрофон занят другим приложением";
        case "OverconstrainedError":
            return "Браузер не смог включить нужный аудиорежим";
        default:
            return error?.message || "Не удалось открыть микрофон";
    }
}

function encodePcm16Mono(samples, inputSampleRate) {
    const resampled = resampleLinear(
        samples,
        inputSampleRate,
        OUTPUT_SAMPLE_RATE,
    );
    const amplified = normalizePeak(resampled);
    const bytes = new ArrayBuffer(amplified.length * 2);
    const view = new DataView(bytes);
    for (let index = 0; index < amplified.length; index += 1) {
        const clamped = clamp(amplified[index], -1, 1);
        const value = clamped < 0 ? clamped * 32768 : clamped * 32767;
        view.setInt16(index * 2, value, true);
    }
    return bytes;
}

function mergeChunks(chunks) {
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
    }
    return samples;
}

function normalizePeak(samples) {
    const peak = samples.reduce(
        (max, sample) => Math.max(max, Math.abs(sample)),
        0,
    );
    if (peak < 0.001) {
        return samples;
    }
    const gain = Math.min(MAX_AUTO_GAIN, TARGET_PEAK / peak);
    if (gain <= 1.02) {
        return samples;
    }
    const normalized = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
        normalized[index] = clamp(samples[index] * gain, -1, 1);
    }
    return normalized;
}

function resampleLinear(samples, fromRate, toRate) {
    if (fromRate === toRate) {
        return samples;
    }
    const ratio = fromRate / toRate;
    const outputLength = Math.max(1, Math.floor(samples.length / ratio));
    const output = new Float32Array(outputLength);
    for (let index = 0; index < outputLength; index += 1) {
        const sourceIndex = index * ratio;
        const leftIndex = Math.floor(sourceIndex);
        const rightIndex = Math.min(leftIndex + 1, samples.length - 1);
        const fraction = sourceIndex - leftIndex;
        output[index] =
            samples[leftIndex] +
            (samples[rightIndex] - samples[leftIndex]) * fraction;
    }
    return output;
}

async function sendAudio(pcmBytes) {
    const response = await fetch(getAudioUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: pcmBytes,
    });
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(body.trim() || `ESP32 вернула ${response.status}`);
    }
}

function getAudioUrl() {
    const inputAddress = elements.address.value.trim().replace(/\/+$/, "");
    const rawAddress = stripProtocol(inputAddress);
    if (!rawAddress) {
        throw new Error("Укажи адрес ESP32");
    }
    elements.address.value = rawAddress;
    return `${getAddressWithProtocol(inputAddress)}/audio`;
}

function stripProtocol(address) {
    return address.trim().replace(/^https?:\/\//i, "");
}

function getAddressWithProtocol(address) {
    return /^https?:\/\//i.test(address) ? address : `http://${address}`;
}

function releasePointer(pointerId) {
    if (pointerId === null) {
        return;
    }
    try {
        elements.button.releasePointerCapture?.(pointerId);
    } catch {}
}

function showFeedback(type) {
    window.clearTimeout(feedbackTimer);
    elements.shell.classList.remove("feedback-ok", "feedback-error");
    void elements.shell.offsetWidth;
    elements.shell.classList.add(`feedback-${type}`);
    feedbackTimer = window.setTimeout(() => {
        elements.shell.classList.remove(`feedback-${type}`);
    }, 1000);
}

function waitForReleaseAnimation(releasedAt) {
    const elapsed = performance.now() - releasedAt;
    const remaining = BUTTON_RELEASE_ANIMATION_MS - elapsed;
    if (remaining <= 0) {
        return Promise.resolve();
    }
    return new Promise((resolve) => window.setTimeout(resolve, remaining));
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
