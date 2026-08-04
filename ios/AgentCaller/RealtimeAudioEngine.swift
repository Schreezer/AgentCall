@preconcurrency import AVFoundation

@MainActor
final class RealtimeAudioEngine {
    nonisolated static let sampleRate: Double = 24_000
    private static let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: sampleRate,
        channels: 1,
        interleaved: false
    )!

    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private let microphoneMuteState = MicrophoneMuteState()

    func start(onMicrophoneAudio: @escaping @Sendable (Data) -> Void) throws {
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: Self.outputFormat)

        let input = engine.inputNode
        try? input.setVoiceProcessingEnabled(true)
        input.isVoiceProcessingAGCEnabled = true
        input.isVoiceProcessingBypassed = false
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else { throw VoiceBootstrapError.invalidResponse }
        let microphoneMuteState = microphoneMuteState
        let microphoneTap: @Sendable (AVAudioPCMBuffer, AVAudioTime) -> Void = { buffer, _ in
            guard !microphoneMuteState.isMuted else { return }
            guard let data = Self.pcm16(buffer: buffer, inputFormat: inputFormat) else { return }
            onMicrophoneAudio(data)
        }
        input.installTap(onBus: 0, bufferSize: 2_048, format: inputFormat, block: microphoneTap)
        engine.prepare()
        try engine.start()
        player.play()
        self.engine = engine
        self.player = player
    }

    func play(_ data: Data) {
        guard let player, let engine, engine.isRunning else { return }
        let frames = data.count / MemoryLayout<Int16>.size
        guard frames > 0,
              let buffer = AVAudioPCMBuffer(
                pcmFormat: Self.outputFormat,
                frameCapacity: AVAudioFrameCount(frames)
              ),
              let floats = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = AVAudioFrameCount(frames)
        data.withUnsafeBytes { raw in
            guard let source = raw.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            for index in 0..<frames {
                floats[index] = Float(Int16(littleEndian: source[index])) / Float(Int16.max)
            }
        }
        player.scheduleBuffer(buffer)
        if !player.isPlaying { player.play() }
    }

    func interruptPlayback() {
        player?.stop()
        player?.play()
    }

    func setMuted(_ muted: Bool) {
        microphoneMuteState.isMuted = muted
    }

    func stop() {
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        player?.stop()
        engine.stop()
        self.engine = nil
        player = nil
    }

    nonisolated private static func pcm16(buffer: AVAudioPCMBuffer, inputFormat: AVAudioFormat) -> Data? {
        let source: AVAudioPCMBuffer
        if inputFormat.sampleRate != sampleRate || inputFormat.channelCount != 1 {
            guard let format = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: sampleRate,
                channels: 1,
                interleaved: false
            ), let converter = AVAudioConverter(from: inputFormat, to: format) else { return nil }
            let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * sampleRate / inputFormat.sampleRate))
            guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
            let supplier = AudioBufferSupplier(buffer)
            var conversionError: NSError?
            converter.convert(to: converted, error: &conversionError) { _, status in
                supplier.next(status: status)
            }
            guard conversionError == nil else { return nil }
            source = converted
        } else {
            source = buffer
        }
        guard let floats = source.floatChannelData?[0] else { return nil }
        var samples = [Int16](repeating: 0, count: Int(source.frameLength))
        for index in samples.indices {
            let value = max(-1, min(1, floats[index]))
            samples[index] = Int16(value * Float(Int16.max - 1)).littleEndian
        }
        return samples.withUnsafeBytes { Data($0) }
    }
}

private final class MicrophoneMuteState: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    var isMuted: Bool {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

private final class AudioBufferSupplier: @unchecked Sendable {
    private var buffer: AVAudioPCMBuffer?

    init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }

    func next(status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
        guard let buffer else {
            status.pointee = .endOfStream
            return nil
        }
        self.buffer = nil
        status.pointee = .haveData
        return buffer
    }
}
