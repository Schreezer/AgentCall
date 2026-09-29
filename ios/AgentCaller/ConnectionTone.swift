import AVFoundation
import Foundation

@MainActor
final class ConnectionTone {
    private var player: AVAudioPlayer?

    func start() {
        guard player == nil else { return }
        do {
            let player = try AVAudioPlayer(data: Self.toneData())
            player.numberOfLoops = -1
            player.volume = 0.62
            guard player.prepareToPlay(), player.play() else { return }
            self.player = player
        } catch {
            player = nil
        }
    }

    func stop() {
        guard let player else { return }
        self.player = nil
        guard player.isPlaying else { player.stop(); return }
        player.setVolume(0, fadeDuration: 0.05)
        Task { @MainActor [player] in
            try? await Task.sleep(for: .milliseconds(60))
            player.stop()
        }
    }

    // A local connecting cue with the familiar two-burst ringback cadence.
    // This is app audio; the phone network supplies its own ringback for PSTN calls.
    static func toneData() -> Data {
        let sampleRate: UInt32 = 48_000
        let channelCount: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let duration = 3.0
        let sampleCount = Int(Double(sampleRate) * duration)
        let bursts: [(start: Double, end: Double)] = [(0, 0.4), (0.6, 1.0)]
        let fadeDuration = 0.012
        var samples = [Int16](repeating: 0, count: sampleCount)

        for burst in bursts {
            let start = Int(burst.start * Double(sampleRate))
            let end = Int(burst.end * Double(sampleRate))
            for index in start..<end {
                let time = Double(index) / Double(sampleRate)
                let fadeIn = min(1, (time - burst.start) / fadeDuration)
                let fadeOut = min(1, (burst.end - time) / fadeDuration)
                let envelope = min(fadeIn, fadeOut)
                // The 400 Hz tone is deliberately clear at receiver volume.
                let sample = sin(2 * Double.pi * 400 * time) * envelope * 0.38
                samples[index] = Int16(sample * Double(Int16.max))
            }
        }

        let byteRate = sampleRate * UInt32(channelCount) * UInt32(bitsPerSample / 8)
        let blockAlign = channelCount * bitsPerSample / 8
        let dataSize = UInt32(samples.count * MemoryLayout<Int16>.size)
        var data = Data()
        data.append("RIFF".data(using: .ascii)!)
        append(UInt32(36) + dataSize, to: &data)
        data.append("WAVEfmt ".data(using: .ascii)!)
        append(UInt32(16), to: &data)
        append(UInt16(1), to: &data)
        append(channelCount, to: &data)
        append(sampleRate, to: &data)
        append(byteRate, to: &data)
        append(blockAlign, to: &data)
        append(bitsPerSample, to: &data)
        data.append("data".data(using: .ascii)!)
        append(dataSize, to: &data)
        for sample in samples { append(sample, to: &data) }
        return data
    }

    private static func append<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
    }
}
