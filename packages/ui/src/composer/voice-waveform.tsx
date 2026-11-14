import { useEffect, useState } from 'react';

const barCount = 24;

export function VoiceWaveform({ stream }: { stream?: MediaStream }) {
  const [levels, setLevels] = useState<number[]>([]);
  useEffect(() => {
    if (!stream || typeof AudioContext === 'undefined') return;
    let context: AudioContext | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      const samples = new Float32Array(analyser.fftSize);
      context.createMediaStreamSource(stream).connect(analyser);
      void context.resume().catch(() => {});
      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let power = 0;
        for (const sample of samples) power += sample * sample;
        const level = Math.min(1, Math.sqrt(power / samples.length) * 4);
        setLevels(history => [...history.slice(1 - barCount), level]);
      }, 100);
    } catch {
      // Metering is optional when the browser can record but cannot analyse the stream.
    }
    return () => {
      clearInterval(timer);
      if (context && context.state !== 'closed') void context.close().catch(() => {});
    };
  }, [stream]);

  return <span className="sp-voice-waveform" aria-hidden="true">
    {Array.from({ length: barCount }, (_, index) => {
      const level = levels[index - barCount + levels.length];
      return <i key={index} data-sampled={level !== undefined || undefined} style={{ height: 3 + 31 * (level ?? 0) }}/>;
    })}
  </span>;
}
