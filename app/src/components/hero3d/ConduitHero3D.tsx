import { useEffect, useRef, useState } from 'react'
import { LedDot } from '../ui/LedDot'
import { mountConduitHero } from './engine'

/**
 * Real-time, resolution-independent 3D hero for the CONDUIT drop.
 * Falls back to the original still if WebGL2 is unavailable.
 */
export function ConduitHero3D({ fallbackSrc, alt }: { fallbackSrc: string; alt: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const azRef = useRef<HTMLSpanElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    return mountConduitHero(canvas, {
      reducedMotion,
      onReady: () => setStatus('ready'),
      onError: (err) => {
        console.warn('[hero3d] falling back to still image:', err)
        setStatus('failed')
      },
      onAzimuth: (deg) => {
        if (azRef.current) azRef.current.textContent = deg.toFixed(1).padStart(5, '0')
      },
    })
  }, [])

  return (
    <div className="relative h-full w-full">
      {/* studio backdrop */}
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_55%_65%_at_50%_42%,rgba(16,185,129,0.14),transparent_70%)]"
        aria-hidden
      />
      <div className="micro-grid pointer-events-none absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_60%_70%_at_50%_50%,black,transparent)]" aria-hidden />

      {status === 'failed' ? (
        <img src={fallbackSrc} alt={alt} className="h-full w-full object-cover object-center" />
      ) : (
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`${alt} — rotating 3D model, drag to inspect`}
          className={`absolute inset-0 h-full w-full transition-opacity duration-1000 ${
            status === 'ready' ? 'opacity-100' : 'opacity-0'
          }`}
        />
      )}

      {status !== 'failed' && (
        <div className="pointer-events-none absolute bottom-2 left-2 hidden items-center gap-2 border border-edge/60 bg-obsidian/90 px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] text-zinc backdrop-blur-md sm:flex">
          <LedDot tone="cyan" fast />
          <span>
            AZIMUTH <span ref={azRef} className="text-bone">000.0</span>° // DRAG TO INSPECT
          </span>
        </div>
      )}
    </div>
  )
}
