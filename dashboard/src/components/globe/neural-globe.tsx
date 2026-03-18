'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'

interface NeuralGlobeProps {
  width?: number
  height?: number
  className?: string
}

export function NeuralGlobe({ width, height, className }: NeuralGlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Scene setup
    const scene = new THREE.Scene()

    const camera = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / container.clientHeight,
      0.1,
      100
    )
    camera.position.z = 5

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(container.clientWidth, container.clientHeight)
    renderer.setClearColor(0x000000)
    container.appendChild(renderer.domElement)

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.3)
    scene.add(ambientLight)

    const pointLight = new THREE.PointLight(0xffffff, 1)
    pointLight.position.set(2, 2, 2)
    scene.add(pointLight)

    // Globe group
    const globeGroup = new THREE.Group()
    scene.add(globeGroup)

    const RADIUS = 1.8
    const NODE_COUNT = 80

    // Generate nodes on sphere surface using spherical coordinates
    const nodePositions: THREE.Vector3[] = []

    const nodeMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.6,
    })

    for (let i = 0; i < NODE_COUNT; i++) {
      // Uniform distribution on sphere surface
      const theta = Math.acos(2 * Math.random() - 1)
      const phi = 2 * Math.PI * Math.random()

      const x = RADIUS * Math.sin(theta) * Math.cos(phi)
      const y = RADIUS * Math.sin(theta) * Math.sin(phi)
      const z = RADIUS * Math.cos(theta)

      const position = new THREE.Vector3(x, y, z)
      nodePositions.push(position)

      const nodeGeometry = new THREE.SphereGeometry(0.02, 8, 8)
      const nodeMesh = new THREE.Mesh(nodeGeometry, nodeMaterial)
      nodeMesh.position.copy(position)
      globeGroup.add(nodeMesh)
    }

    // Connections: each node connects to 2-3 nearest neighbours
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0x333333,
      opacity: 0.4,
      transparent: true,
    })

    for (let i = 0; i < NODE_COUNT; i++) {
      // Compute distances to all other nodes
      const distances: { index: number; dist: number }[] = []
      for (let j = 0; j < NODE_COUNT; j++) {
        if (i === j) continue
        distances.push({
          index: j,
          dist: nodePositions[i].distanceTo(nodePositions[j]),
        })
      }
      distances.sort((a, b) => a.dist - b.dist)

      // Pick 2 or 3 nearest neighbours
      const neighbourCount = Math.random() < 0.5 ? 2 : 3
      for (let k = 0; k < neighbourCount; k++) {
        const neighbour = distances[k]
        // Only draw line if i < neighbour.index to avoid duplicates
        if (i < neighbour.index) {
          const points = [nodePositions[i], nodePositions[neighbour.index]]
          const lineGeometry = new THREE.BufferGeometry().setFromPoints(points)
          const line = new THREE.Line(lineGeometry, lineMaterial)
          globeGroup.add(line)
        }
      }
    }

    // Animation loop
    let animationId: number
    let t = 0

    const animate = () => {
      animationId = requestAnimationFrame(animate)
      t++

      globeGroup.rotation.y += 0.003
      globeGroup.rotation.x = Math.sin(t * 0.0003) * 0.1

      renderer.render(scene, camera)
    }

    animate()

    // Resize handler
    const handleResize = () => {
      if (!container) return
      const w = container.clientWidth
      const h = container.clientHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }

    window.addEventListener('resize', handleResize)

    // Cleanup
    return () => {
      window.removeEventListener('resize', handleResize)
      cancelAnimationFrame(animationId)
      renderer.dispose()
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement)
      }
    }
  }, [])

  const style: React.CSSProperties = {
    width: width ? `${width}px` : '100%',
    height: height ? `${height}px` : '100%',
  }

  return (
    <div
      ref={containerRef}
      className={className}
      style={style}
    />
  )
}
