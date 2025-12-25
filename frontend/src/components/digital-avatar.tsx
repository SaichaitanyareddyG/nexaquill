"use client";

import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

export type DigitalAvatarMode = "idle" | "listening" | "speaking";

type DigitalAvatarProps = {
  mode: DigitalAvatarMode;
};

export function DigitalAvatar({ mode }: DigitalAvatarProps): JSX.Element {
  const [mouthScale, setMouthScale] = useState(0.25);
  const [eyeOffsets, setEyeOffsets] = useState<{ left: number; right: number }>({ left: 0, right: 0 });
  const [isBlinking, setIsBlinking] = useState(false);
  const reopenTimeout = useRef<number | null>(null);

  useEffect(() => {
    let animationTimeout: number | null = null;
    const tick = () => {
      if (mode === "speaking") {
        setMouthScale(0.45 + Math.random() * 0.4);
        setEyeOffsets({
          left: (Math.random() - 0.5) * 4,
          right: (Math.random() - 0.5) * 4,
        });
        animationTimeout = window.setTimeout(tick, 110 + Math.random() * 90);
      } else if (mode === "listening") {
        setMouthScale(0.3 + Math.random() * 0.15);
        setEyeOffsets({
          left: (Math.random() - 0.5) * 2,
          right: (Math.random() - 0.5) * 2,
        });
        animationTimeout = window.setTimeout(tick, 260 + Math.random() * 220);
      } else {
        setMouthScale(0.22);
        setEyeOffsets({ left: 0, right: 0 });
      }
    };

    tick();

    return () => {
      if (animationTimeout) {
        window.clearTimeout(animationTimeout);
      }
    };
  }, [mode]);

  useEffect(() => {
    let blinkTimeout: number | null = null;

    const scheduleBlink = () => {
      const baseDelay = mode === "speaking" ? 2200 : mode === "listening" ? 3200 : 4400;
      blinkTimeout = window.setTimeout(() => {
        setIsBlinking(true);
        reopenTimeout.current = window.setTimeout(() => {
          setIsBlinking(false);
        }, 140);
        scheduleBlink();
      }, baseDelay + Math.random() * 900);
    };

    scheduleBlink();

    return () => {
      if (blinkTimeout) {
        window.clearTimeout(blinkTimeout);
      }
      if (reopenTimeout.current) {
        window.clearTimeout(reopenTimeout.current);
        reopenTimeout.current = null;
      }
      setIsBlinking(false);
    };
  }, [mode]);

  const mouthTransform = useMemo(() => ({
    transform: `scaleY(${mouthScale})`,
  }), [mouthScale]);

  const leftEyeTransform = useMemo(
    () => ({
      transform: `translateY(${eyeOffsets.left}px) scaleY(${isBlinking ? 0.1 : 1})`,
    }),
    [eyeOffsets.left, isBlinking]
  );

  const rightEyeTransform = useMemo(
    () => ({
      transform: `translateY(${eyeOffsets.right}px) scaleY(${isBlinking ? 0.1 : 1})`,
    }),
    [eyeOffsets.right, isBlinking]
  );

  return (
    <div className={`avatar-badge avatar-badge--${mode}`} aria-hidden="true">
      <span className="avatar-badge__face">
        <span className="avatar-badge__eyes">
          <span className="avatar-badge__eye avatar-badge__eye--left" style={leftEyeTransform} />
          <span className="avatar-badge__eye avatar-badge__eye--right" style={rightEyeTransform} />
        </span>
        <span className="avatar-badge__mouth" style={mouthTransform} />
      </span>
    </div>
  );
}
