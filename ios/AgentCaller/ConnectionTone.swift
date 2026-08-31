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
            player.volume = 0.28
            guard player.prepareToPlay(), player.play() else { return }
            self.player = player
        } catch {
            player = nil
        }
    }

    func stop() {
        player?.stop()
        player = nil
    }

    private static func toneData() -> Data {
        let sampleRate: UInt32 = 48_000
        let channelCount: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let duration = 1.1
        let sampleCount = Int(Double(sampleRate) * duration)
        let toneSamples = Int(Double(sampleRate) * 0.14)
        let fadeSamples = Int(Double(sampleRate) * 0.02)
        var samples = [Int16](repeating: 0, count: sampleCount)

        for index in 0..<toneSamples {
            let fadeIn = min(1, Double(index) / Double(fadeSamples))
            let fadeOut = min(1, Double(toneSamples - index) / Double(fadeSamples))
            let envelope = min(fadeIn, fadeOut)
            let phase = 2 * Double.pi * 440 * Double(index) / Double(sampleRate)
            samples[index] = Int16(sin(phase) * envelope * 0.16 * Double(Int16.max))
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
