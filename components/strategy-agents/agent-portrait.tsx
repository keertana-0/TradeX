'use client';

import { useState } from 'react';
import Image from 'next/image';

export function AgentPortrait({ image, name, className = '' }: { image: string; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`agent-portrait ${className}`} aria-label={`${name} portrait`}>
      {failed ? <span aria-hidden="true">{name.slice(0, 2)}</span> : <Image src={image} alt={`${name} portrait`} width={256} height={256} unoptimized onError={() => setFailed(true)} />}
    </span>
  );
}
