'use client'
import { useState, useEffect } from 'react'

export function Clock() {
  const [time, setTime] = useState('')
  useEffect(() => {
    const update = () => setTime(new Date().toTimeString().slice(0, 8))
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <span
      style={{
        fontSize: '10px',
        color: '#444',
        fontVariantNumeric: 'tabular-nums',
        fontFamily: 'var(--font-mono)',
      }}
    >
      {time}
    </span>
  )
}
