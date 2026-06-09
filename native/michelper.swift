// michelper — prints "1" if any input-capable audio device (microphone) is
// currently in use (i.e. you're in a call), else "0". Uses CoreAudio's
// kAudioDevicePropertyDeviceIsRunningSomewhere on input devices. Requires NO
// microphone permission — it only queries device state, never records.
import CoreAudio

func runningSomewhere(_ dev: AudioObjectID) -> Bool {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var v: UInt32 = 0
    var s = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(dev, &addr, 0, nil, &s, &v) == noErr && v != 0
}

func hasInput(_ dev: AudioObjectID) -> Bool {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioObjectPropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    if AudioObjectGetPropertyDataSize(dev, &addr, 0, nil, &size) != noErr || size == 0 { return false }
    let buf = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 8)
    defer { buf.deallocate() }
    if AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, buf) != noErr { return false }
    return buf.assumingMemoryBound(to: AudioBufferList.self).pointee.mNumberBuffers > 0
}

var addr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
var size: UInt32 = 0
AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
var devices = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &devices)

var active = false
for dev in devices where hasInput(dev) && runningSomewhere(dev) { active = true; break }
print(active ? "1" : "0")
