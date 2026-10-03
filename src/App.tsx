import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { useLiveQuery } from 'dexie-react-hooks';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { db, type SavedBook } from './db';

const BOOKS_PER_SHELF = 36;
const SHELF_HEIGHT_GAP = 3.3;
const SHELF_DEPTH = 2.4;
const SHELF_THICKNESS = 0.22;
const SHELF_WIDTH = 13.2;
const BOOK_GAP = 0.03;

interface ResolvedBookData {
  title: string;
  author: string;
  isbn: string;
  coverUrl: string;
  blurb: string;
  pageCount?: number;
  format?: string;
  customHeight?: number;
  customDepth?: number;
  customThickness?: number;
}

function getFoilColors(hex: string) {
  const c = new THREE.Color(hex);
  const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  if (lum < 0.28) {
    return { 
      text: '#e8dcc4', 
      mutedText: 'rgba(232, 220, 196, 0.75)', 
      border: 'rgba(218, 185, 120, 0.45)', 
      shadow: 'rgba(0, 0, 0, 0.9)' 
    };
  } else if (lum < 0.65) {
    return { 
      text: '#ffffff', 
      mutedText: 'rgba(255, 255, 255, 0.8)', 
      border: 'rgba(255, 255, 255, 0.35)', 
      shadow: 'rgba(0, 0, 0, 0.7)' 
    };
  } else {
    return { 
      text: '#1c1917', 
      mutedText: 'rgba(28, 25, 23, 0.75)', 
      border: 'rgba(28, 25, 23, 0.3)', 
      shadow: 'rgba(255, 255, 255, 0.4)' 
    };
  }
}

function getIsbnVariants(isbn: string): string[] {
  const clean = isbn.replace(/[^0-9X]/gi, '').toUpperCase();
  const variants = [clean];
  if (clean.length === 13 && clean.startsWith('978')) {
    const core = clean.slice(3, 12);
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += (10 - i) * parseInt(core[i], 10);
    }
    const rem = (11 - (sum % 11)) % 11;
    const check = rem === 10 ? 'X' : String(rem);
    variants.push(core + check);
  } else if (clean.length === 10) {
    const core = '978' + clean.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += parseInt(core[i], 10) * (i % 2 === 0 ? 1 : 3);
    }
    const check = (10 - (sum % 10)) % 10;
    variants.push(core + String(check));
  }
  return [...new Set(variants)];
}

function parseDimensionUnit(str?: string): number | null {
  if (!str) return null;
  const match = str.toLowerCase().match(/([\d.]+)\s*(cm|mm|in|inches|inch)?/);
  if (!match) return null;
  const val = parseFloat(match[1]);
  const unit = match[2] || 'cm';
  if (unit.startsWith('in')) return val * 2.54;
  if (unit === 'mm') return val / 10;
  return val;
}

function parseThreePartDimensions(dimStr?: string) {
  if (!dimStr) return null;
  const isInch = dimStr.toLowerCase().includes('in');
  const nums = dimStr.match(/[\d.]+/g)?.map(Number);
  if (!nums || nums.length < 2) return null;
  const factor = isInch ? 2.54 : 1.0;

  if (nums.length >= 3) {
    return {
      heightCm: Math.max(nums[0], nums[1]) * factor,
      depthCm: Math.min(nums[0], nums[1]) * factor,
      thicknessCm: nums[2] * factor,
    };
  } else if (nums.length === 2) {
    return {
      heightCm: Math.max(nums[0], nums[1]) * factor,
      depthCm: Math.min(nums[0], nums[1]) * factor,
      thicknessCm: null,
    };
  }
  return null;
}

function getBookDimensions(book: SavedBook) {
  const isHardcover = (book.format || '').toLowerCase().includes('hard') || (book.format || '').toLowerCase().includes('bound');
  const overhangY = isHardcover ? 0.065 : 0;

  if (book.customHeight && book.customThickness && book.customDepth) {
    const baseH = book.customHeight;
    return {
      thickness: book.customThickness,
      height: baseH + overhangY * 2,
      depth: book.customDepth,
      pageHeight: baseH,
      isHardcover,
      overhangY
    };
  }

  const pages = Math.max(book.pageCount || 300, 16);

  const thickness = book.customThickness ?? Math.min(
    Math.max((pages * 0.00058) + (isHardcover ? 0.08 : 0.032), 0.13),
    0.95
  );

  let baseHeight = book.customHeight ?? 2.12;
  if (!book.customHeight) {
    if (pages > 850) baseHeight = 2.45;
    else if (pages > 550) baseHeight = 2.32;
    else if (pages < 200) baseHeight = 1.95;
    else if (pages < 350) baseHeight = 2.08;
  }

  const outerHeight = baseHeight + overhangY * 2;
  const depth = book.customDepth ?? (1.48 + thickness * 0.08);

  return { 
    thickness, 
    height: outerHeight, 
    depth, 
    pageHeight: baseHeight, 
    isHardcover, 
    overhangY 
  };
}

function createPaperbackGeometry(thickness: number, height: number, depth: number) {
  const geom = new THREE.BoxGeometry(thickness, height, depth, 32, 1, 32);
  const pos = geom.attributes.position;
  const halfX = thickness / 2;
  const halfZ = depth / 2;
  const r = Math.min(thickness * 0.28, 0.048);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);

    if (z > halfZ - r) {
      if (x > halfX - r) {
        const cx = halfX - r;
        const cz = halfZ - r;
        const dx = x - cx;
        const dz = z - cz;
        const len = Math.hypot(dx, dz);
        if (len > r) {
          pos.setX(i, cx + (dx / len) * r);
          pos.setZ(i, cz + (dz / len) * r);
        }
      } else if (x < -halfX + r) {
        const cx = -halfX + r;
        const cz = halfZ - r;
        const dx = x - cx;
        const dz = z - cz;
        const len = Math.hypot(dx, dz);
        if (len > r) {
          pos.setX(i, cx + (dx / len) * r);
          pos.setZ(i, cz + (dz / len) * r);
        }
      }
    }
  }

  geom.computeVertexNormals();
  return geom;
}

function createHardcoverSpineGeometry(thickness: number, jacketHeight: number, spineThick: number) {
  const geom = new THREE.BoxGeometry(thickness, jacketHeight, spineThick, 24, 1, 4);
  const pos = geom.attributes.position;
  const halfX = thickness / 2;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const normX = x / halfX;
    const arch = (1 - normX * normX) * (thickness * 0.14 + 0.02);
    pos.setZ(i, pos.getZ(i) + arch);
  }

  geom.computeVertexNormals();
  return geom;
}

function createBokehTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#060608';
  ctx.fillRect(0, 0, 1024, 1024);

  for (let i = 0; i < 85; i++) {
    const x = Math.random() * 1024;
    const y = Math.random() * 1024;
    const radius = Math.random() * 160 + 60;
    const orbGrad = ctx.createRadialGradient(x, y, radius * 0.02, x, y, radius);
    const alpha = Math.random() * 0.08 + 0.025;

    orbGrad.addColorStop(0, `rgba(235, 225, 210, ${alpha * 1.5})`);
    orbGrad.addColorStop(0.5, `rgba(140, 128, 110, ${alpha * 0.5})`);
    orbGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.fillStyle = orbGrad;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const requestGyroPermission = async () => {
  if (typeof (DeviceOrientationEvent as any)?.requestPermission === 'function') {
    try {
      const response = await (DeviceOrientationEvent as any).requestPermission();
      if (response === 'granted') {
        window.addEventListener('deviceorientation', () => {});
      }
    } catch (err) {
      console.warn('Gyro permission rejected', err);
    }
  }
};

// Robust, Memory-Safe Audio Engine with Perceptual Volume Curves
class SoundSystem {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private bgMasterGain: GainNode | null = null;
  private sfxMasterGain: GainNode | null = null;
  private darkGain: GainNode | null = null;
  private lightGain: GainNode | null = null;

  private isInitialized = false;
  private currentTheme: 'dark' | 'light' = 'dark';

  private bgEnabled = true;
  private bgVolume = 0.55;
  private sfxEnabled = true;
  private sfxVolume = 0.75;

  private pianoProgressionIndex = 0;
  private activeIntervals: number[] = [];

  private toPerceptualGain(val: number): number {
    return Math.pow(Math.max(0, Math.min(1, val)), 2.4);
  }

  public init() {
    if (this.isInitialized) return;
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;

    try {
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 1.0;
      this.masterGain.connect(this.ctx.destination);

      this.bgMasterGain = this.ctx.createGain();
      this.bgMasterGain.gain.value = this.bgEnabled ? this.toPerceptualGain(this.bgVolume) : 0;
      this.bgMasterGain.connect(this.masterGain);

      this.sfxMasterGain = this.ctx.createGain();
      this.sfxMasterGain.gain.value = this.sfxEnabled ? this.toPerceptualGain(this.sfxVolume) : 0;
      this.sfxMasterGain.connect(this.masterGain);

      this.darkGain = this.ctx.createGain();
      this.darkGain.gain.value = this.currentTheme === 'dark' ? 1.0 : 0.0;
      this.darkGain.connect(this.bgMasterGain);

      this.lightGain = this.ctx.createGain();
      this.lightGain.gain.value = this.currentTheme === 'light' ? 1.0 : 0.0;
      this.lightGain.connect(this.bgMasterGain);

      this.startDarkAmbience();
      this.startLightAmbience();
      this.isInitialized = true;
    } catch (e) {
      console.warn('AudioContext initialization deferred:', e);
    }
  }

  public resume() {
    if (!this.isInitialized) {
      this.init();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  public setTheme(theme: 'dark' | 'light') {
    this.currentTheme = theme;
    if (!this.ctx || !this.darkGain || !this.lightGain) return;
    const now = this.ctx.currentTime;
    
    this.darkGain.gain.cancelScheduledValues(now);
    this.darkGain.gain.setValueAtTime(this.darkGain.gain.value, now);
    this.darkGain.gain.linearRampToValueAtTime(theme === 'dark' ? 1.0 : 0.0, now + 0.5);

    this.lightGain.gain.cancelScheduledValues(now);
    this.lightGain.gain.setValueAtTime(this.lightGain.gain.value, now);
    this.lightGain.gain.linearRampToValueAtTime(theme === 'light' ? 1.0 : 0.0, now + 0.5);
  }

  public setBgEnabled(enabled: boolean) {
    this.bgEnabled = enabled;
    this.resume();
    if (!this.ctx || !this.bgMasterGain) return;
    const now = this.ctx.currentTime;
    this.bgMasterGain.gain.cancelScheduledValues(now);
    this.bgMasterGain.gain.setValueAtTime(this.bgMasterGain.gain.value, now);
    this.bgMasterGain.gain.linearRampToValueAtTime(enabled ? this.toPerceptualGain(this.bgVolume) : 0, now + 0.1);
  }

  public setBgVolume(vol: number) {
    this.bgVolume = vol;
    this.resume();
    if (!this.ctx || !this.bgMasterGain) return;
    const now = this.ctx.currentTime;
    if (this.bgEnabled) {
      this.bgMasterGain.gain.cancelScheduledValues(now);
      this.bgMasterGain.gain.setValueAtTime(this.bgMasterGain.gain.value, now);
      this.bgMasterGain.gain.linearRampToValueAtTime(this.toPerceptualGain(vol), now + 0.05);
    }
  }

  public setSfxEnabled(enabled: boolean) {
    this.sfxEnabled = enabled;
    this.resume();
    if (!this.ctx || !this.sfxMasterGain) return;
    const now = this.ctx.currentTime;
    this.sfxMasterGain.gain.cancelScheduledValues(now);
    this.sfxMasterGain.gain.setValueAtTime(this.sfxMasterGain.gain.value, now);
    this.sfxMasterGain.gain.linearRampToValueAtTime(enabled ? this.toPerceptualGain(this.sfxVolume) : 0, now + 0.1);
  }

  public setSfxVolume(vol: number) {
    this.sfxVolume = vol;
    this.resume();
    if (!this.ctx || !this.sfxMasterGain) return;
    const now = this.ctx.currentTime;
    if (this.sfxEnabled) {
      this.sfxMasterGain.gain.cancelScheduledValues(now);
      this.sfxMasterGain.gain.setValueAtTime(this.sfxMasterGain.gain.value, now);
      this.sfxMasterGain.gain.linearRampToValueAtTime(this.toPerceptualGain(vol), now + 0.05);
    }
  }

  private startDarkAmbience() {
    if (!this.ctx || !this.darkGain) return;

    const bufferSize = this.ctx.sampleRate * 2;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.9976 * b0 + white * 0.04;
      b1 = 0.963 * b1 + white * 0.08;
      b2 = 0.57 * b2 + white * 0.22;
      output[i] = (b0 + b1 + b2) * 0.032;
    }
    const airSrc = this.ctx.createBufferSource();
    airSrc.buffer = noiseBuffer;
    airSrc.loop = true;
    const airFilter = this.ctx.createBiquadFilter();
    airFilter.type = 'lowpass';
    airFilter.frequency.value = 220;
    const airGain = this.ctx.createGain();
    airGain.gain.value = 0.035;

    airSrc.connect(airFilter);
    airFilter.connect(airGain);
    airGain.connect(this.darkGain);
    airSrc.start();

    const pageTurnTimer = window.setInterval(() => {
      if (this.currentTheme === 'dark' && this.bgEnabled) {
        this.playBackgroundMutedTurn();
      }
    }, 7600);
    this.activeIntervals.push(pageTurnTimer);

    const pianoTimer = window.setInterval(() => {
      if (this.currentTheme === 'dark' && this.bgEnabled) {
        this.playCalmPianoPhrase();
      }
    }, 5000);
    this.activeIntervals.push(pianoTimer);
  }

  private playBackgroundMutedTurn() {
    if (!this.ctx || !this.darkGain) return;
    const now = this.ctx.currentTime;
    const dur = 0.42;
    const bufferSize = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.sin((i / bufferSize) * Math.PI);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(420, now);
    filter.frequency.exponentialRampToValueAtTime(140, now + dur);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.022, now + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.darkGain);

    src.onended = () => {
      src.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
    src.start(now);
  }

  private playPianoNote(freq: number, startTime: number, duration: number, velocity: number) {
    if (!this.ctx || !this.darkGain) return;

    const oscSine = this.ctx.createOscillator();
    const oscTri = this.ctx.createOscillator();

    oscSine.type = 'sine';
    oscSine.frequency.setValueAtTime(freq, startTime);

    oscTri.type = 'triangle';
    oscTri.frequency.setValueAtTime(freq, startTime);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.min(1800, freq * 3.2), startTime);
    filter.frequency.exponentialRampToValueAtTime(Math.max(220, freq * 1.1), startTime + duration);

    const noteGain = this.ctx.createGain();
    noteGain.gain.setValueAtTime(0.0001, startTime);
    noteGain.gain.linearRampToValueAtTime(velocity * 0.08, startTime + 0.022);
    noteGain.gain.exponentialRampToValueAtTime(velocity * 0.03, startTime + 0.45);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    const triGain = this.ctx.createGain();
    triGain.gain.value = 0.28;

    oscSine.connect(filter);
    oscTri.connect(triGain);
    triGain.connect(filter);
    filter.connect(noteGain);
    noteGain.connect(this.darkGain);

    const cleanup = () => {
      oscSine.disconnect();
      oscTri.disconnect();
      triGain.disconnect();
      filter.disconnect();
      noteGain.disconnect();
    };
    oscSine.onended = cleanup;

    oscSine.start(startTime);
    oscTri.start(startTime);
    oscSine.stop(startTime + duration + 0.05);
    oscTri.stop(startTime + duration + 0.05);
  }

  private playCalmPianoPhrase() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const chords = [
      [174.61, 261.63, 329.63, 440.0],
      [130.81, 196.0, 293.66, 329.63, 493.88],
      [110.0, 164.81, 261.63, 392.0],
      [146.83, 220.0, 293.66, 369.99, 440.0]
    ];
    const chord = chords[this.pianoProgressionIndex % chords.length];
    this.pianoProgressionIndex++;

    const notesToPlay = Math.random() > 0.35 ? 3 : 2;
    for (let i = 0; i < notesToPlay; i++) {
      const noteFreq = chord[i % chord.length];
      const offset = i * (0.18 + Math.random() * 0.08);
      const dur = 3.6 + Math.random() * 1.2;
      const vel = 0.72 - i * 0.12 + Math.random() * 0.12;
      this.playPianoNote(noteFreq, now + offset, dur, vel);
    }
  }

  private startLightAmbience() {
    if (!this.ctx || !this.lightGain) return;

    const bufferSize = this.ctx.sampleRate * 2;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = (Math.random() * 2 - 1) * 0.026;
    }
    const breezeSrc = this.ctx.createBufferSource();
    breezeSrc.buffer = noiseBuffer;
    breezeSrc.loop = true;

    const breezeFilter = this.ctx.createBiquadFilter();
    breezeFilter.type = 'lowpass';
    breezeFilter.frequency.value = 650;
    const breezeGain = this.ctx.createGain();
    breezeGain.gain.value = 0.016;

    breezeSrc.connect(breezeFilter);
    breezeFilter.connect(breezeGain);
    breezeGain.connect(this.lightGain);
    breezeSrc.start();

    const chirpTimer = window.setInterval(() => {
      if (this.currentTheme === 'light' && this.bgEnabled) {
        this.playVeryLowVolumeBirdSong();
      }
    }, 5400);
    this.activeIntervals.push(chirpTimer);
  }

  private playVeryLowVolumeBirdSong() {
    if (!this.ctx || !this.lightGain) return;
    const now = this.ctx.currentTime;
    const notes = [2600, 3050, 3450];
    let t = now + Math.random() * 0.1;
    notes.forEach((freq, idx) => {
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();
      const dur = 0.04 + Math.random() * 0.015;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * 0.95, t);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.05, t + dur * 0.35);

      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.0035 - idx * 0.0006, t + dur * 0.25);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      osc.connect(gain);
      gain.connect(this.lightGain!);

      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };

      osc.start(t);
      osc.stop(t + dur + 0.02);
      t += dur + 0.04;
    });
  }

  public playButtonHum() {
    this.resume();
    if (!this.ctx || !this.sfxMasterGain || !this.sfxEnabled) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(68, now + 0.11);

    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);

    osc.connect(gain);
    gain.connect(this.sfxMasterGain);

    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };

    osc.start(now);
    osc.stop(now + 0.12);
  }

  public playDeepSoftWhoosh() {
    this.resume();
    if (!this.ctx || !this.sfxMasterGain || !this.sfxEnabled) return;
    const now = this.ctx.currentTime;
    const dur = 0.32;
    const bufferSize = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.sin((i / bufferSize) * Math.PI);
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buf;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(480, now);
    filter.frequency.exponentialRampToValueAtTime(110, now + dur);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    const subOsc = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(86, now);
    subOsc.frequency.exponentialRampToValueAtTime(42, now + dur);

    subGain.gain.setValueAtTime(0.0001, now);
    subGain.gain.linearRampToValueAtTime(0.06, now + 0.04);
    subGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxMasterGain);

    subOsc.connect(subGain);
    subGain.connect(this.sfxMasterGain);

    src.onended = () => {
      src.disconnect();
      filter.disconnect();
      gain.disconnect();
      subOsc.disconnect();
      subGain.disconnect();
    };

    src.start(now);
    subOsc.start(now);
    subOsc.stop(now + dur + 0.02);
  }

  public playThump() {
    this.resume();
    if (!this.ctx || !this.sfxMasterGain || !this.sfxEnabled) return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const oscGain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(115, now);
    osc.frequency.exponentialRampToValueAtTime(32, now + 0.19);

    oscGain.gain.setValueAtTime(0.28, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

    osc.connect(oscGain);
    oscGain.connect(this.sfxMasterGain);

    const nBuf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * 0.09), this.ctx.sampleRate);
    const nData = nBuf.getChannelData(0);
    for (let i = 0; i < nData.length; i++) {
      nData[i] = (Math.random() * 2 - 1) * Math.exp(-i / (this.ctx.sampleRate * 0.018));
    }
    const nSrc = this.ctx.createBufferSource();
    nSrc.buffer = nBuf;
    const nFilter = this.ctx.createBiquadFilter();
    nFilter.type = 'lowpass';
    nFilter.frequency.value = 260;
    const nGain = this.ctx.createGain();
    nGain.gain.value = 0.15;

    nSrc.connect(nFilter);
    nFilter.connect(nGain);
    nGain.connect(this.sfxMasterGain);

    osc.onended = () => {
      osc.disconnect();
      oscGain.disconnect();
      nSrc.disconnect();
      nFilter.disconnect();
      nGain.disconnect();
    };

    osc.start(now);
    osc.stop(now + 0.21);
    nSrc.start(now);
  }
}

const audioManager = new SoundSystem();

function CameraController({ 
  isSelected, 
  showMobileDetails,
  isPickingPosition, 
  isBrowseMode,
  isIdle,
  books,
  bookShelfPositions,
  totalShelves,
  browsedTargetPos,
  isUserInteracting,
  isMobile,
  controlsRef 
}: { 
  isSelected: boolean; 
  showMobileDetails: boolean; 
  isPickingPosition: boolean; 
  isBrowseMode: boolean;
  isIdle: boolean;
  books: SavedBook[];
  bookShelfPositions: Map<number, { x: number; row: number }>;
  totalShelves: number;
  browsedTargetPos: { x: number; y: number } | null;
  isUserInteracting: React.MutableRefObject<boolean>;
  isMobile: boolean;
  controlsRef: React.RefObject<any>; 
}) {
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const wasSelected = useRef(false);
  const wasBrowseMode = useRef(false);
  const wasIdle = useRef(false);
  const returningToNeutral = useRef(false);

  const idleElapsed = useRef(0);
  const initialIdleCamPos = useRef(new THREE.Vector3());
  const initialIdleLookAt = useRef(new THREE.Vector3());

  useEffect(() => {
    if (wasBrowseMode.current && !isBrowseMode) {
      returningToNeutral.current = true;
    }
    wasBrowseMode.current = isBrowseMode;
  }, [isBrowseMode]);

  useEffect(() => {
    if (wasIdle.current && !isIdle) {
      returningToNeutral.current = true;
      idleElapsed.current = 0;
    }
    wasIdle.current = isIdle;
  }, [isIdle]);

  useFrame(({ camera }, delta) => {
    const dt = Math.min(delta, 0.05);

    if (isPickingPosition) {
      camera.position.x = THREE.MathUtils.lerp(camera.position.x, 0, dt * 4);
      camera.position.y = THREE.MathUtils.lerp(camera.position.y, 0.1, dt * 4);
      camera.position.z = THREE.MathUtils.lerp(camera.position.z, 13.6, dt * 4);
      if (controlsRef.current) {
        controlsRef.current.target.lerp(new THREE.Vector3(0, 0, 0), dt * 4);
        controlsRef.current.update();
      }
    } else if (isSelected) {
      wasSelected.current = true;

      const camX = 0;
      const camY = isMobile ? (showMobileDetails ? 0.80 : 0.42) : 0.48;
      const camZ = isMobile ? 8.4 : 9.4;

      camera.position.x = THREE.MathUtils.lerp(camera.position.x, camX, dt * 4.5);
      camera.position.y = THREE.MathUtils.lerp(camera.position.y, camY, dt * 4.5);
      camera.position.z = THREE.MathUtils.lerp(camera.position.z, camZ, dt * 4.5);

      const targetLookAt = new THREE.Vector3(0, camY, 0);
      dummy.position.copy(camera.position);
      dummy.lookAt(targetLookAt);
      camera.quaternion.slerp(dummy.quaternion, dt * 4.5);

      if (controlsRef.current) {
        controlsRef.current.target.lerp(targetLookAt, dt * 4.5);
        controlsRef.current.update();
      }
    } else if (wasSelected.current) {
      camera.position.x = THREE.MathUtils.lerp(camera.position.x, 0, dt * 3.5);
      camera.position.y = THREE.MathUtils.lerp(camera.position.y, 0.0, dt * 3.5);
      camera.position.z = THREE.MathUtils.lerp(camera.position.z, 12.6, dt * 3.5);

      if (controlsRef.current) {
        controlsRef.current.target.lerp(new THREE.Vector3(0, 0, 0), dt * 3.5);
        controlsRef.current.update();
      }

      if (Math.abs(camera.position.z - 12.6) < 0.08 && Math.abs(camera.position.x) < 0.08) {
        wasSelected.current = false;
      }
    } else if (isBrowseMode && browsedTargetPos) {
      const targetLookAt = new THREE.Vector3(browsedTargetPos.x, browsedTargetPos.y, 1.55);
      const camDistX = isMobile ? 5.8 : 5.2;
      const camDistY = isMobile ? 0.38 : 0.42;
      const camDistZ = isMobile ? 3.6 : 3.6;
      const forcedCamPos = new THREE.Vector3(browsedTargetPos.x + camDistX, browsedTargetPos.y + camDistY, 1.55 + camDistZ);

      if (!isUserInteracting.current) {
        camera.position.lerp(forcedCamPos, dt * 4.5);
        if (controlsRef.current) {
          controlsRef.current.target.lerp(targetLookAt, dt * 4.8);
          controlsRef.current.update();
        }
      }
    } else if (isIdle) {
      if (idleElapsed.current === 0) {
        initialIdleCamPos.current.copy(camera.position);
        if (controlsRef.current) {
          initialIdleLookAt.current.copy(controlsRef.current.target);
        } else {
          initialIdleLookAt.current.set(0, 0, 0);
        }
      }

      idleElapsed.current += dt;
      const t = idleElapsed.current;

      let minX = -1.0;
      let maxX = 1.0;
      let avgY = 0;

      if (books.length > 0) {
        let first = true;
        let ySum = 0;
        let count = 0;

        books.forEach((b) => {
          if (b.id !== undefined) {
            const p = bookShelfPositions.get(b.id);
            if (p) {
              const sTopY = (p.row - (totalShelves - 1) / 2) * SHELF_HEIGHT_GAP - 1.25 + SHELF_THICKNESS / 2;
              const bY = sTopY + getBookDimensions(b).height / 2;
              ySum += bY;
              count++;
              if (first) {
                minX = p.x;
                maxX = p.x;
                first = false;
              } else {
                minX = Math.min(minX, p.x);
                maxX = Math.max(maxX, p.x);
              }
            }
          }
        });
        if (count > 0) avgY = ySum / count;
      }

      const bookSpan = Math.max(2.2, (maxX - minX));
      const shelfCenter = (minX + maxX) / 2;
      const panAmplitude = Math.min(bookSpan * 0.42, 4.2);

      const panSpeed = 0.08; 
      const rawPan = Math.sin(t * panSpeed);
      const panOffset = rawPan * panAmplitude;

      const idleCamDistZ = isMobile ? 6.0 : 5.2;
      
      const extremeFactor = Math.pow(Math.abs(rawPan), 3.0) * Math.sign(rawPan);
      const targetCamX = shelfCenter + panOffset + (extremeFactor * 1.1);
      const targetLookX = shelfCenter + (panOffset * 0.7) + (extremeFactor * 0.9);

      const targetIdlePos = new THREE.Vector3(
        targetCamX,
        avgY + Math.sin(t * (panSpeed * 0.5)) * 0.12,
        idleCamDistZ
      );

      const targetIdleLookAt = new THREE.Vector3(
        targetLookX,
        avgY,
        0.4
      );

      const zoomDuration = 10.0;
      const zoomFrac = Math.min(t / zoomDuration, 1.0);
      const easeZoom = 0.5 - 0.5 * Math.cos(zoomFrac * Math.PI);

      const blendedPos = new THREE.Vector3().lerpVectors(initialIdleCamPos.current, targetIdlePos, easeZoom);
      const blendedLookAt = new THREE.Vector3().lerpVectors(initialIdleLookAt.current, targetIdleLookAt, easeZoom);

      camera.position.lerp(blendedPos, dt * 1.4);
      if (controlsRef.current) {
        controlsRef.current.target.lerp(blendedLookAt, dt * 1.4);
        controlsRef.current.update();
      }
    } else if (returningToNeutral.current) {
      if (isUserInteracting.current) {
        returningToNeutral.current = false;
        return;
      }
      camera.position.x = THREE.MathUtils.lerp(camera.position.x, 0, dt * 4.0);
      camera.position.y = THREE.MathUtils.lerp(camera.position.y, 0.0, dt * 4.0);
      camera.position.z = THREE.MathUtils.lerp(camera.position.z, 12.6, dt * 4.0);

      if (controlsRef.current) {
        controlsRef.current.target.lerp(new THREE.Vector3(0, 0, 0), dt * 4.0);
        controlsRef.current.update();
      }

      if (Math.abs(camera.position.z - 12.6) < 0.08 && Math.abs(camera.position.x) < 0.08) {
        returningToNeutral.current = false;
      }
    }
  });
  return null;
}

function DarkFocusCurtain({ active, themeProgress }: { active: boolean; themeProgress: React.MutableRefObject<number> }) {
  const meshRef = useRef<THREE.Mesh>(null!);
  const bokehTexture = useMemo(() => createBokehTexture(), []);

  useFrame((_, delta) => {
    if (!meshRef.current) return;
    const dt = Math.min(delta, 0.05);
    const mat = meshRef.current.material as THREE.MeshBasicMaterial;
    
    const darkCurtainColor = new THREE.Color('#0c0c0e');
    const lightCurtainColor = new THREE.Color('#ede8de');
    mat.color.lerpColors(darkCurtainColor, lightCurtainColor, themeProgress.current);

    const targetOpacity = active ? 0.94 : 0.0;
    mat.opacity = THREE.MathUtils.lerp(mat.opacity, targetOpacity, dt * 5.0);
  });

  return (
    <mesh ref={meshRef} position={[0, 0, 1.6]}>
      <planeGeometry args={[65, 40]} />
      <meshBasicMaterial 
        map={bokehTexture} 
        transparent 
        opacity={0} 
        depthWrite={false} 
      />
    </mesh>
  );
}

function BookcaseLamp({ position, themeProgress }: { position: [number, number, number]; themeProgress: React.MutableRefObject<number> }) {
  const matRef = useRef<THREE.MeshStandardMaterial>(null!);

  useFrame(() => {
    if (matRef.current) {
      const darkBrass = new THREE.Color('#827464');
      const lightBrass = new THREE.Color('#b59877');
      matRef.current.color.lerpColors(darkBrass, lightBrass, themeProgress.current);
    }
  });

  return (
    <group position={position}>
      <mesh position={[0, 0, -0.45]}>
        <boxGeometry args={[0.2, 0.26, 0.12]} />
        <meshStandardMaterial ref={matRef} metalness={0.85} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.18, -0.2]}>
        <cylinderGeometry args={[0.022, 0.022, 0.6, 12]} />
        <primitive object={matRef.current ? matRef.current : new THREE.MeshStandardMaterial()} attach="material" />
      </mesh>
      <mesh position={[0, 0.35, 0.16]} rotation={[Math.PI / 3.4, 0, 0]}>
        <cylinderGeometry args={[0.022, 0.022, 0.5, 12]} />
        <primitive object={matRef.current ? matRef.current : new THREE.MeshStandardMaterial()} attach="material" />
      </mesh>
      <mesh position={[0, 0.44, 0.45]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.105, 0.105, 0.95, 16, 1, false, 0, Math.PI]} />
        <primitive object={matRef.current ? matRef.current : new THREE.MeshStandardMaterial()} attach="material" />
      </mesh>
      <mesh position={[0, 0.38, 0.45]}>
        <boxGeometry args={[0.8, 0.04, 0.04]} />
        <meshBasicMaterial color="#f5f0ea" />
      </mesh>
    </group>
  );
}

function UnderShelfPuck({ 
  x, 
  y, 
  z, 
  isSelected,
  themeProgress
}: { 
  x: number; 
  y: number; 
  z: number; 
  isSelected: boolean; 
  themeProgress: React.MutableRefObject<number>;
}) {
  const spotRef = useRef<THREE.SpotLight>(null!);
  const [downwardTarget] = useState(() => {
    const obj = new THREE.Object3D();
    obj.position.set(x, y - 2.8, z);
    return obj;
  });

  useEffect(() => {
    if (spotRef.current) {
      spotRef.current.target = downwardTarget;
      spotRef.current.target.updateMatrixWorld();
    }
  }, [downwardTarget]);

  const isOuterPuck = Math.abs(x) > 3.0;

  useFrame((_, delta) => {
    if (spotRef.current) {
      const dt = Math.min(delta, 0.05);
      const darkIntensity = isSelected ? 7.5 : (isOuterPuck ? 21.0 : 16.0);
      const targetIntensity = darkIntensity * (1 - themeProgress.current);
      spotRef.current.intensity = THREE.MathUtils.lerp(spotRef.current.intensity, targetIntensity, dt * 6.0);
    }
  });

  return (
    <group>
      <primitive object={downwardTarget} />

      <group position={[x, y, z]}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.05, 0.08, 24]} />
          <meshStandardMaterial color="#14100c" roughness={0.5} metalness={0.9} side={THREE.DoubleSide} />
        </mesh>
        <mesh position={[0, -0.002, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.05, 24]} />
          <meshBasicMaterial color="#fffbeb" />
        </mesh>
      </group>

      <spotLight
        ref={spotRef}
        position={[x, y, z]}
        intensity={isSelected ? 7.5 : 16.0}
        angle={Math.PI / 3.0}
        penumbra={0.85}
        distance={SHELF_HEIGHT_GAP + 0.6}
        decay={1.2}
        color="#fff4dc"
      />
    </group>
  );
}

function NeutralLibraryLightingRig({ 
  totalShelves, 
  isSelected, 
  showMobileDetails,
  isMobile,
  themeProgress
}: { 
  totalShelves: number; 
  isSelected: boolean; 
  showMobileDetails: boolean; 
  isMobile: boolean; 
  themeProgress: React.MutableRefObject<number>;
}) {
  const topCrownY = ((totalShelves - 1) / 2) * SHELF_HEIGHT_GAP + 1.65;
  const inspectionSpotRef = useRef<THREE.SpotLight>(null!);
  const ambientRef = useRef<THREE.AmbientLight>(null!);
  const dirLightRef = useRef<THREE.DirectionalLight>(null!);
  const topSpotLeftRef = useRef<THREE.SpotLight>(null!);
  const topSpotCenterRef = useRef<THREE.SpotLight>(null!);
  const topSpotRightRef = useRef<THREE.SpotLight>(null!);

  const leftTarget = useMemo(() => {
    const obj = new THREE.Object3D();
    obj.position.set(-3.8, 0, 0.2);
    return obj;
  }, []);

  const rightTarget = useMemo(() => {
    const obj = new THREE.Object3D();
    obj.position.set(3.8, 0, 0.2);
    return obj;
  }, []);

  const centerTarget = useMemo(() => {
    const obj = new THREE.Object3D();
    obj.position.set(0, 0, 0.2);
    return obj;
  }, []);

  const inspectionTarget = useMemo(() => {
    const obj = new THREE.Object3D();
    obj.position.set(0, 0.42, 3.6);
    return obj;
  }, []);

  useFrame(({ camera }, delta) => {
    const dt = Math.min(delta, 0.05);
    const p = themeProgress.current;

    if (ambientRef.current) {
      const darkAmbColor = new THREE.Color('#948778');
      const lightAmbColor = new THREE.Color('#fff4e4');
      ambientRef.current.color.lerpColors(darkAmbColor, lightAmbColor, p);

      const darkAmbInt = isSelected ? 0.75 : 1.15;
      const lightAmbInt = isSelected ? 1.45 : 2.1;
      const targetAmb = THREE.MathUtils.lerp(darkAmbInt, lightAmbInt, p);
      ambientRef.current.intensity = THREE.MathUtils.lerp(ambientRef.current.intensity, targetAmb, dt * 6.0);
    }

    if (dirLightRef.current) {
      const darkDirColor = new THREE.Color('#ffffff');
      const lightDirColor = new THREE.Color('#ffe2b8');
      dirLightRef.current.color.lerpColors(darkDirColor, lightDirColor, p);

      const darkDirInt = isSelected ? 0.65 : 1.5;
      const lightDirInt = isSelected ? 1.6 : 2.5;
      const targetDirInt = THREE.MathUtils.lerp(darkDirInt, lightDirInt, p);
      dirLightRef.current.intensity = THREE.MathUtils.lerp(dirLightRef.current.intensity, targetDirInt, dt * 6.0);
    }

    const topSpotTarget = (isSelected ? 18 : 64) * (1 - p);
    if (topSpotLeftRef.current) {
      topSpotLeftRef.current.intensity = THREE.MathUtils.lerp(topSpotLeftRef.current.intensity, topSpotTarget, dt * 6.0);
    }
    if (topSpotCenterRef.current) {
      topSpotCenterRef.current.intensity = THREE.MathUtils.lerp(topSpotCenterRef.current.intensity, topSpotTarget * 0.72, dt * 6.0);
    }
    if (topSpotRightRef.current) {
      topSpotRightRef.current.intensity = THREE.MathUtils.lerp(topSpotRightRef.current.intensity, topSpotTarget, dt * 6.0);
    }

    if (inspectionSpotRef.current) {
      const spotX = isMobile ? 0 : -0.7;
      const spotY = isMobile ? (showMobileDetails ? 1.26 : 0.42) : 0.48;

      inspectionTarget.position.set(spotX, spotY, 3.6);
      inspectionTarget.updateMatrixWorld();

      inspectionSpotRef.current.position.set(
        camera.position.x,
        camera.position.y + 1.3,
        camera.position.z + 0.3
      );

      const inspColorDark = new THREE.Color('#fffbf2');
      const inspColorLight = new THREE.Color('#fff6ec');
      inspectionSpotRef.current.color.lerpColors(inspColorDark, inspColorLight, p);
      
      const darkIntensity = 6.8;
      const lightIntensity = 4.2;
      const targetInt = isSelected ? THREE.MathUtils.lerp(darkIntensity, lightIntensity, p) : 0.0;
      inspectionSpotRef.current.intensity = THREE.MathUtils.lerp(inspectionSpotRef.current.intensity, targetInt, dt * 8.0);
    }
  });

  return (
    <>
      <primitive object={leftTarget} />
      <primitive object={rightTarget} />
      <primitive object={centerTarget} />
      <primitive object={inspectionTarget} />

      <ambientLight ref={ambientRef} intensity={0.85} color="#948778" />

      <BookcaseLamp position={[-4.2, topCrownY + 0.1, 0.8]} themeProgress={themeProgress} />
      <BookcaseLamp position={[0, topCrownY + 0.1, 0.8]} themeProgress={themeProgress} />
      <BookcaseLamp position={[4.2, topCrownY + 0.1, 0.8]} themeProgress={themeProgress} />

      <spotLight
        ref={topSpotLeftRef}
        position={[-4.2, topCrownY + 0.5, 1.3]}
        target={leftTarget}
        intensity={64}
        angle={Math.PI / 2.7}
        penumbra={0.65}
        distance={22}
        decay={1.2}
        color="#fff8f0"
        castShadow
        shadow-mapSize-width={isMobile ? 512 : 1024}
        shadow-mapSize-height={isMobile ? 512 : 1024}
        shadow-bias={-0.0001}
      />

      <spotLight
        ref={topSpotCenterRef}
        position={[0, topCrownY + 0.5, 1.3]}
        target={centerTarget}
        intensity={46}
        angle={Math.PI / 2.7}
        penumbra={0.65}
        distance={22}
        decay={1.2}
        color="#fff8f0"
        castShadow
        shadow-mapSize-width={isMobile ? 512 : 1024}
        shadow-mapSize-height={isMobile ? 512 : 1024}
        shadow-bias={-0.0001}
      />

      <spotLight
        ref={topSpotRightRef}
        position={[4.2, topCrownY + 0.5, 1.3]}
        target={rightTarget}
        intensity={64}
        angle={Math.PI / 2.7}
        penumbra={0.65}
        distance={22}
        decay={1.2}
        color="#fff8f0"
        castShadow
        shadow-mapSize-width={isMobile ? 512 : 1024}
        shadow-mapSize-height={isMobile ? 512 : 1024}
        shadow-bias={-0.0001}
      />

      <directionalLight
        ref={dirLightRef}
        position={[3.2, 5.2, 7.2]}
        intensity={1.5}
        color="#ffffff"
        castShadow
        shadow-mapSize-width={isMobile ? 1024 : 2048}
        shadow-mapSize-height={isMobile ? 1024 : 2048}
        shadow-camera-near={0.5}
        shadow-camera-far={25}
        shadow-camera-left={-10}
        shadow-camera-right={10}
        shadow-camera-top={8}
        shadow-camera-bottom={-8}
        shadow-bias={-0.0001}
      />

      {Array.from({ length: totalShelves }).map((_, i) => {
        const sourceShelfY = i === totalShelves - 1 
          ? topCrownY 
          : ((i + 1) - (totalShelves - 1) / 2) * SHELF_HEIGHT_GAP - 1.25;
        const lampY = sourceShelfY - SHELF_THICKNESS / 2;
        const lampZ = 0.05;

        return (
          <group key={`shelf-pucks-${i}`}>
            <UnderShelfPuck x={-4.4} y={lampY} z={lampZ} isSelected={isSelected} themeProgress={themeProgress} />
            <UnderShelfPuck x={-1.5} y={lampY} z={lampZ} isSelected={isSelected} themeProgress={themeProgress} />
            <UnderShelfPuck x={1.5} y={lampY} z={lampZ} isSelected={isSelected} themeProgress={themeProgress} />
            <UnderShelfPuck x={4.4} y={lampY} z={lampZ} isSelected={isSelected} themeProgress={themeProgress} />
          </group>
        );
      })}

      <spotLight
        ref={inspectionSpotRef}
        target={inspectionTarget}
        intensity={0}
        angle={Math.PI / 3.0}
        penumbra={0.88}
        distance={20}
        decay={1.15}
        color="#fffbf2"
      />
    </>
  );
}

function createPublisherSpine(
  title: string,
  author: string,
  baseColor: string,
  thickness: number
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(140, Math.round(thickness * 520));
  canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const curveGrad = ctx.createLinearGradient(0, 0, canvas.width, 0);
  curveGrad.addColorStop(0, 'rgba(0, 0, 0, 0.45)');
  curveGrad.addColorStop(0.12, 'rgba(255, 255, 255, 0.12)');
  curveGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.02)');
  curveGrad.addColorStop(0.88, 'rgba(255, 255, 255, 0.1)');
  curveGrad.addColorStop(1, 'rgba(0, 0, 0, 0.5)');
  ctx.fillStyle = curveGrad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < canvas.height; y += 4) {
    ctx.fillStyle = y % 8 === 0 ? 'rgba(0, 0, 0, 0.04)' : 'rgba(255, 255, 255, 0.03)';
    ctx.fillRect(0, y, canvas.width, 1);
  }

  const foil = getFoilColors(baseColor);
  ctx.strokeStyle = foil.border;
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 20, canvas.width - 16, canvas.height - 40);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.fillRect(8, 20, canvas.width - 16, 6);
  ctx.fillRect(8, canvas.height - 26, canvas.width - 16, 6);

  const cleanTitle = title.replace(/\s*\([^)]*\)/g, '').split(':')[0].trim();

  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const titleSize = Math.max(16, Math.min(28, Math.round(canvas.width * 0.16)));
  const authorSize = Math.max(12, Math.round(titleSize * 0.72));

  ctx.shadowColor = foil.shadow;
  ctx.shadowBlur = 3;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;

  ctx.fillStyle = foil.text;
  ctx.font = `700 ${titleSize}px Georgia, "Times New Roman", serif`;
  const displayTitle = cleanTitle.length > 28 ? cleanTitle.slice(0, 26) + '...' : cleanTitle;
  ctx.fillText(displayTitle.toUpperCase(), -40, 0);

  ctx.fillStyle = foil.mutedText;
  ctx.font = `500 ${authorSize}px system-ui, -apple-system, sans-serif`;
  const displayAuthor = author.length > 22 ? author.slice(0, 20) + '...' : author;
  ctx.fillText(displayAuthor, 280, 0);

  ctx.restore();

  const markW = Math.min(32, canvas.width * 0.36);
  const markX = (canvas.width - markW) / 2;
  const markY = canvas.height - markW - 36;
  ctx.strokeStyle = foil.border;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(markX, markY, markW, markW);

  ctx.fillStyle = foil.text;
  ctx.font = 'bold 11px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(cleanTitle.charAt(0) || '★', markX + markW / 2, markY + markW / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createPublisherBackCover(
  title: string,
  author: string,
  blurb: string,
  isbn: string,
  baseColor: string
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const vignette = ctx.createLinearGradient(0, 0, 0, canvas.height);
  vignette.addColorStop(0, 'rgba(255, 255, 255, 0.05)');
  vignette.addColorStop(0.5, 'rgba(0, 0, 0, 0.15)');
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < canvas.height; y += 4) {
    ctx.fillStyle = y % 8 === 0 ? 'rgba(0, 0, 0, 0.02)' : 'rgba(255, 255, 255, 0.02)';
    ctx.fillRect(0, y, canvas.width, 1);
  }

  const foil = getFoilColors(baseColor);
  const cleanTitle = title.replace(/\s*\([^)]*\)/g, '').split(':')[0].trim();

  ctx.fillStyle = foil.text;
  ctx.font = 'bold 30px Georgia, serif';
  ctx.textAlign = 'left';
  ctx.fillText(cleanTitle.length > 32 ? cleanTitle.slice(0, 30) + '...' : cleanTitle, 52, 80);

  ctx.fillStyle = foil.mutedText;
  ctx.font = 'italic 20px Georgia, serif';
  ctx.fillText(`By ${author}`, 52, 115);

  ctx.strokeStyle = foil.border;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(52, 138);
  ctx.lineTo(canvas.width - 52, 138);
  ctx.stroke();

  ctx.fillStyle = foil.text;
  ctx.font = '20px/32px Georgia, serif';
  const words = (blurb || 'No publisher synopsis recorded.').replace(/<[^>]+>/g, '').split(/\s+/);
  let line = '';
  let y = 185;
  let count = 0;

  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = ctx.measureText(testLine);
    if (metrics.width > canvas.width - 104 && n > 0) {
      ctx.fillText(line.trim(), 52, y);
      line = words[n] + ' ';
      y += 32;
      count++;
      if (count >= 16) {
        ctx.fillText(line.trim() + '...', 52, y);
        break;
      }
    } else {
      line = testLine;
    }
  }
  if (count < 16) ctx.fillText(line.trim(), 52, y);

  const bWidth = 230;
  const bHeight = 110;
  const bX = canvas.width - bWidth - 52;
  const bY = canvas.height - bHeight - 52;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(bX, bY, bWidth, bHeight);

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`ISBN ${isbn || '978-0000000000'}`, bX + bWidth / 2, bY + 18);
  ctx.font = '9px monospace';
  ctx.fillText('FICTION / LITERATURE', bX + bWidth / 2, bY + 30);

  for (let i = 18; i < bWidth - 18; i += 4) {
    if ((i * 31) % 5 !== 0) {
      ctx.fillRect(bX + i, bY + 36, 2.5, 64);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createPageTextures() {
  const canvasTB = document.createElement('canvas');
  canvasTB.width = 512;
  canvasTB.height = 512;
  const ctxTB = canvasTB.getContext('2d')!;
  ctxTB.fillStyle = '#fdfbf7';
  ctxTB.fillRect(0, 0, 512, 512);

  for (let x = 0; x < 512; x += 2) {
    const darkness = Math.random() * 0.14 + 0.02;
    ctxTB.fillStyle = `rgba(90, 70, 45, ${darkness})`;
    ctxTB.fillRect(x, 0, 1, 512);
  }

  const topBottom = new THREE.CanvasTexture(canvasTB);
  topBottom.wrapS = THREE.RepeatWrapping;
  topBottom.wrapT = THREE.RepeatWrapping;
  topBottom.colorSpace = THREE.SRGBColorSpace;
  topBottom.needsUpdate = true;

  const canvasFE = document.createElement('canvas');
  canvasFE.width = 512;
  canvasFE.height = 512;
  const ctxFE = canvasFE.getContext('2d')!;
  ctxFE.fillStyle = '#fdfbf7';
  ctxFE.fillRect(0, 0, 512, 512);

  for (let x = 0; x < 512; x += 2) {
    const darkness = Math.random() * 0.14 + 0.02;
    ctxTB.fillStyle = `rgba(90, 70, 45, ${darkness})`;
    ctxFE.fillRect(x, 0, 1, 512);
  }

  const foreEdge = new THREE.CanvasTexture(canvasFE);
  foreEdge.wrapS = THREE.RepeatWrapping;
  foreEdge.wrapT = THREE.RepeatWrapping;
  foreEdge.colorSpace = THREE.SRGBColorSpace;
  foreEdge.needsUpdate = true;

  return { topBottom, foreEdge };
}

function createWoodTextures() {
  const width = 1024;
  const height = 1024;
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = width;
  colorCanvas.height = height;
  const ctx = colorCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = width;
  bumpCanvas.height = height;
  const bCtx = bumpCanvas.getContext('2d')!;

  const baseGrad = ctx.createLinearGradient(0, 0, width, 0);
  baseGrad.addColorStop(0, '#e2d2bd');
  baseGrad.addColorStop(0.28, '#d7c4ad');
  baseGrad.addColorStop(0.6, '#e4d5c1');
  baseGrad.addColorStop(0.85, '#d3bea7');
  baseGrad.addColorStop(1, '#dfceb9');
  ctx.fillStyle = baseGrad;
  ctx.fillRect(0, 0, width, height);

  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, width, height);

  for (let i = 0; i < 750; i++) {
    const x = Math.random() * width;
    const lineWidth = Math.random() * 2.2 + 0.4;
    const alpha = Math.random() * 0.22 + 0.05;
    const isDarkLine = Math.random() > 0.4;

    ctx.strokeStyle = isDarkLine ? `rgba(108, 85, 62, ${alpha * 0.6})` : `rgba(255, 252, 245, ${alpha * 0.65})`;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(x, 0);

    const wave = (Math.random() - 0.5) * 12;
    ctx.bezierCurveTo(x + wave, height * 0.33, x - wave, height * 0.66, x + (Math.random() - 0.5) * 8, height);
    ctx.stroke();

    bCtx.strokeStyle = isDarkLine ? `rgba(25, 25, 25, ${alpha * 2.2})` : `rgba(215, 215, 215, ${alpha * 1.3})`;
    bCtx.lineWidth = lineWidth;
    bCtx.stroke();
  }

  const map = new THREE.CanvasTexture(colorCanvas);
  map.wrapS = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.needsUpdate = true;

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;
  bumpMap.needsUpdate = true;

  return { map, bumpMap };
}

function createBackpanelTextures() {
  const width = 1024;
  const height = 1024;
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = width;
  colorCanvas.height = height;
  const ctx = colorCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = width;
  bumpCanvas.height = height;
  const bCtx = bumpCanvas.getContext('2d')!;

  ctx.fillStyle = '#d8c5ae';
  ctx.fillRect(0, 0, width, height);

  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, width, height);

  const plankW = 72;
  for (let x = 0; x < width; x += plankW) {
    ctx.fillStyle = 'rgba(92, 70, 48, 0.45)';
    ctx.fillRect(x, 0, 2.0, height);
    ctx.fillStyle = 'rgba(255, 252, 245, 0.45)';
    ctx.fillRect(x + 2.0, 0, 1.2, height);

    bCtx.fillStyle = '#080808';
    bCtx.fillRect(x, 0, 2.0, height);
    bCtx.fillStyle = '#b8b8b8';
    bCtx.fillRect(x + 2.0, 0, 1.2, height);
  }

  const map = new THREE.CanvasTexture(colorCanvas);
  map.wrapS = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.needsUpdate = true;

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;
  bumpMap.needsUpdate = true;

  return { map, bumpMap };
}

function ArchitecturalBookcase({ shelfCount, themeProgress }: { shelfCount: number; themeProgress: React.MutableRefObject<number> }) {
  const caseHeight = (shelfCount - 1) * SHELF_HEIGHT_GAP + 3.1;
  const woodTextures = useMemo(() => createWoodTextures(), []);
  const backTextures = useMemo(() => createBackpanelTextures(), []);

  const woodMaterial = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      map: woodTextures.map,
      bumpMap: woodTextures.bumpMap,
      bumpScale: 0.045,
      roughness: 0.44,
      metalness: 0.02
    });
  }, [woodTextures]);

  const backMaterial = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      map: backTextures.map,
      bumpMap: backTextures.bumpMap,
      bumpScale: 0.04,
      roughness: 0.65,
      metalness: 0.01
    });
  }, [backTextures]);

  useFrame(() => {
    const p = themeProgress.current;

    const darkWoodTint = new THREE.Color('#241b16');
    const ikeaBeigeWoodTint = new THREE.Color('#ffffff');
    woodMaterial.color.lerpColors(darkWoodTint, ikeaBeigeWoodTint, p);
    woodMaterial.roughness = THREE.MathUtils.lerp(0.44, 0.52, p);

    const darkBackTint = new THREE.Color('#16100c');
    const ikeaBeigeBackTint = new THREE.Color('#ffffff');
    backMaterial.color.lerpColors(darkBackTint, ikeaBeigeBackTint, p);
  });

  const topY = ((shelfCount - 1) / 2) * SHELF_HEIGHT_GAP + 1.65;
  const bottomY = -((shelfCount - 1) / 2) * SHELF_HEIGHT_GAP - 1.45;

  return (
    <group>
      {/* Fullroom Architectural Back-Wall Extension */}
      <mesh position={[0, 0, -SHELF_DEPTH / 2 - 0.08]} material={backMaterial} receiveShadow>
        <planeGeometry args={[SHELF_WIDTH + 16, (shelfCount + 6) * SHELF_HEIGHT_GAP + 18]} />
      </mesh>

      {/* Upward Arch/Crown Soffit Extension */}
      <mesh position={[0, topY + 4.5, -SHELF_DEPTH / 2 + 0.12]} material={woodMaterial} receiveShadow>
        <boxGeometry args={[SHELF_WIDTH + 0.72, 8.8, 0.35]} />
      </mesh>

      {Array.from({ length: shelfCount }).map((_, i) => {
        const y = (i - (shelfCount - 1) / 2) * SHELF_HEIGHT_GAP - 1.25;
        return (
          <group key={i} position={[0, y, 0]}>
            <mesh material={woodMaterial} receiveShadow castShadow>
              <boxGeometry args={[SHELF_WIDTH, SHELF_THICKNESS, SHELF_DEPTH]} />
            </mesh>
            <mesh position={[0, 0, SHELF_DEPTH / 2]} rotation={[0, 0, Math.PI / 2]} material={woodMaterial} castShadow receiveShadow>
              <cylinderGeometry args={[SHELF_THICKNESS / 2, SHELF_THICKNESS / 2, SHELF_WIDTH, 16]} />
            </mesh>
            <mesh position={[0, -SHELF_THICKNESS / 2 - 0.035, SHELF_DEPTH / 2 - 0.08]} material={woodMaterial} castShadow receiveShadow>
              <boxGeometry args={[SHELF_WIDTH, 0.07, 0.08]} />
            </mesh>
          </group>
        );
      })}

      <group position={[0, topY, 0]}>
        <mesh position={[0, 0, 0]} material={woodMaterial} castShadow receiveShadow>
          <boxGeometry args={[SHELF_WIDTH + 0.38, SHELF_THICKNESS + 0.08, SHELF_DEPTH + 0.14]} />
        </mesh>
        <mesh position={[0, 0.15, 0.04]} material={woodMaterial} castShadow receiveShadow>
          <boxGeometry args={[SHELF_WIDTH + 0.52, 0.12, SHELF_DEPTH + 0.22]} />
        </mesh>
        <mesh position={[0, 0.24, 0.07]} material={woodMaterial} castShadow receiveShadow>
          <boxGeometry args={[SHELF_WIDTH + 0.62, 0.08, SHELF_DEPTH + 0.28]} />
        </mesh>
      </group>

      <group position={[0, bottomY, 0]}>
        <mesh position={[0, 0, 0]} material={woodMaterial} receiveShadow castShadow>
          <boxGeometry args={[SHELF_WIDTH + 0.36, 0.28, SHELF_DEPTH + 0.12]} />
        </mesh>
        <mesh position={[0, -0.16, 0.04]} material={woodMaterial} receiveShadow castShadow>
          <boxGeometry args={[SHELF_WIDTH + 0.48, 0.12, SHELF_DEPTH + 0.2]} />
        </mesh>
      </group>

      {[-1, 1].map((side) => {
        const xPos = side * (SHELF_WIDTH / 2 + SHELF_THICKNESS / 2);
        return (
          <group key={side} position={[xPos, 0, 0]}>
            <mesh material={woodMaterial} castShadow receiveShadow>
              <boxGeometry args={[SHELF_THICKNESS, caseHeight + 6, SHELF_DEPTH]} />
            </mesh>
            <mesh position={[0, 0, SHELF_DEPTH / 2 + 0.03]} material={woodMaterial} castShadow receiveShadow>
              <boxGeometry args={[SHELF_THICKNESS + 0.08, caseHeight + 6.12, 0.06]} />
            </mesh>
          </group>
        );
      })}

      <mesh position={[0, 0, -SHELF_DEPTH / 2 + 0.08]} material={backMaterial} receiveShadow={true} castShadow={false}>
        <boxGeometry args={[SHELF_WIDTH + 0.1, caseHeight - 0.1, 0.14]} />
      </mesh>
    </group>
  );
}

function GlidedPlacementPlane({
  totalShelves,
  books,
  editingBook,
  isMobile,
  hoveredPlacement,
  onHoverSlot,
  onConfirmPlacement,
  onStartDrag,
  onEndDrag
}: {
  totalShelves: number;
  books: SavedBook[];
  editingBook: SavedBook;
  isMobile: boolean;
  hoveredPlacement: { row: number; slot: number } | null;
  onHoverSlot: (slot: { row: number; slot: number }) => void;
  onConfirmPlacement: (row: number, slot: number) => void;
  onStartDrag: () => void;
  onEndDrag: () => void;
}) {
  const isPointerDown = useRef(false);

  const calculatePlacement = (point: THREE.Vector3) => {
    let closestRow = 0;
    let minRowDist = Infinity;
    for (let r = 0; r < totalShelves; r++) {
      const shelfTopY = (r - (totalShelves - 1) / 2) * SHELF_HEIGHT_GAP - 1.25 + SHELF_THICKNESS / 2;
      const dist = Math.abs(point.y - (shelfTopY + 1.15));
      if (dist < minRowDist) {
        minRowDist = dist;
        closestRow = r;
      }
    }

    const rowBooks = books
      .filter(b => (b.shelfRow ?? 0) === closestRow && b.id !== editingBook.id)
      .sort((a, b) => (a.shelfIndex ?? 0) - (b.shelfIndex ?? 0));

    const thicknesses = rowBooks.map(b => getBookDimensions(b).thickness);
    const N = rowBooks.length;

    if (N === 0) {
      return { row: closestRow, slot: 0 };
    }

    const existingTotalW = thicknesses.reduce((s, t) => s + t, 0) + Math.max(0, N - 1) * BOOK_GAP;
    let curX = -existingTotalW / 2;
    let slot = N;
    for (let i = 0; i < N; i++) {
      const bookCenter = curX + thicknesses[i] / 2;
      if (point.x < bookCenter) {
        slot = i;
        break;
      }
      curX += thicknesses[i] + BOOK_GAP;
    }

    return { row: closestRow, slot };
  };

  return (
    <mesh
      position={[0, 0, 0.75]}
      onPointerDown={(e) => {
        e.stopPropagation();
        isPointerDown.current = true;
        onStartDrag();
        if (e.point) {
          const res = calculatePlacement(e.point);
          onHoverSlot(res);
          if (!isMobile) {
            onConfirmPlacement(res.row, res.slot);
          }
        }
      }}
      onPointerMove={(e) => {
        if (e.point) {
          if (!isMobile || isPointerDown.current) {
            e.stopPropagation();
            const res = calculatePlacement(e.point);
            onHoverSlot(res);
          }
        }
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        if (isMobile && isPointerDown.current && hoveredPlacement) {
          onConfirmPlacement(hoveredPlacement.row, hoveredPlacement.slot);
        }
        isPointerDown.current = false;
        onEndDrag();
      }}
      onPointerCancel={() => {
        isPointerDown.current = false;
        onEndDrag();
      }}
    >
      <planeGeometry args={[SHELF_WIDTH + 4, totalShelves * SHELF_HEIGHT_GAP + 4]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

function GhostBookPreview({ 
  totalShelves, 
  books, 
  editingBook, 
  hoveredPlacement 
}: { 
  totalShelves: number; 
  books: SavedBook[]; 
  editingBook: SavedBook | null; 
  hoveredPlacement: { row: number; slot: number } | null; 
}) {
  const row = hoveredPlacement?.row ?? 0;
  const slot = hoveredPlacement?.slot ?? 0;

  const rowBooks = books
    .filter(b => (b.shelfRow ?? 0) === row && b.id !== editingBook?.id)
    .sort((a, b) => (a.shelfIndex ?? 0) - (b.shelfIndex ?? 0));

  const previewDim = editingBook 
    ? getBookDimensions(editingBook) 
    : { thickness: 0.35, height: 2.15, depth: 1.55 };

  const thicknesses = rowBooks.map(b => getBookDimensions(b).thickness);
  const totalW = thicknesses.reduce((sum, t) => sum + t, 0) + Math.max(0, rowBooks.length - 1) * BOOK_GAP + previewDim.thickness + (rowBooks.length > 0 ? BOOK_GAP : 0);
  let runX = -totalW / 2;
  let ghostX = 0;
  for (let i = 0; i <= rowBooks.length; i++) {
    if (i === slot) {
      ghostX = runX + previewDim.thickness / 2;
      break;
    }
    runX += thicknesses[i] + BOOK_GAP;
  }

  const shelfTopY = (row - (totalShelves - 1) / 2) * SHELF_HEIGHT_GAP - 1.25 + SHELF_THICKNESS / 2;
  const ghostY = shelfTopY + previewDim.height / 2;

  return (
    <group position={[ghostX, ghostY, 0]}>
      <mesh castShadow={false} receiveShadow={false}>
        <boxGeometry args={[previewDim.thickness, previewDim.height, previewDim.depth]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.65} wireframe={false} />
      </mesh>
    </group>
  );
}

function BookMesh({ 
  book, 
  shelfX, 
  shelfRow, 
  totalShelves, 
  isSelected, 
  isFlipped, 
  isDeleting, 
  isHighlighted, 
  isPlacing, 
  isHovered, 
  isEditingOrAdding, 
  isBrowseMode, 
  isMobile,
  showMobileDetails,
  hasSelection, 
  placementMode,
  ghostNormPos,
  pointerPos, 
  onHover, 
  onUnhover, 
  onSelect 
}: { 
  book: SavedBook; 
  shelfX: number; 
  shelfRow: number; 
  totalShelves: number; 
  isSelected: boolean; 
  isFlipped: boolean; 
  isDeleting: boolean; 
  isHighlighted: boolean; 
  isPlacing: boolean; 
  isHovered: boolean; 
  isEditingOrAdding: boolean; 
  isBrowseMode: boolean; 
  isMobile: boolean;
  showMobileDetails: boolean;
  hasSelection: boolean; 
  placementMode: 'glide' | 'dpad';
  ghostNormPos: { x: number; y: number } | null;
  pointerPos: React.MutableRefObject<{ x: number; y: number }>; 
  onHover: () => void; 
  onUnhover: () => void; 
  onSelect: () => void; 
}) {
  const groupRef = useRef<THREE.Group>(null!);
  const [extractedColor, setExtractedColor] = useState<string>(book.color || '#2c3e50');

  const inspectRot = useRef({ x: 0, y: 0 });
  const isDraggingInspect = useRef(false);
  const lastDragPos = useRef({ x: 0, y: 0 });

  const { thickness, height, depth, pageHeight, isHardcover, overhangY } = useMemo(() => getBookDimensions(book), [book]);
  
  const defaultX = shelfX;
  const shelfTopY = (shelfRow - (totalShelves - 1) / 2) * SHELF_HEIGHT_GAP - 1.25 + SHELF_THICKNESS / 2;
  const defaultY = shelfTopY + height / 2;

  useLayoutEffect(() => {
    if (!groupRef.current) return;
    if (isPlacing) {
      groupRef.current.position.set(-1.35, -0.75, 5.5);
    } else {
      groupRef.current.position.set(defaultX, defaultY, 0);
    }
  }, []);

  useEffect(() => {
    if (groupRef.current) {
      (groupRef.current as any).raycast = isPlacing ? () => null : THREE.Mesh.prototype.raycast;
    }
  }, [isPlacing]);

  useEffect(() => {
    if (!book.coverUrl) return;
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.src = book.coverUrl;
    img.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = 16;
        cv.height = 16;
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, 16, 16);
        const p = ctx.getImageData(1, 1, 1, 1).data;
        const hex = `#${((1 << 24) + (p[0] << 16) + (p[1] << 8) + p[2]).toString(16).slice(1)}`;
        setExtractedColor(hex);
      } catch (e) {}
    };
  }, [book.coverUrl]);

  const materials = useMemo(() => {
    const pageTextures = createPageTextures();
    
    const topBottomPageMat = new THREE.MeshStandardMaterial({ 
      map: pageTextures.topBottom, 
      bumpMap: pageTextures.topBottom, 
      bumpScale: 0.03, 
      roughness: 0.85, 
      color: '#fcf8f0', 
      transparent: true, 
      depthWrite: true 
    });

    const foreEdgePageMat = new THREE.MeshStandardMaterial({ 
      map: pageTextures.foreEdge, 
      bumpMap: pageTextures.foreEdge, 
      bumpScale: 0.03, 
      roughness: 0.85, 
      color: '#fcf8f0', 
      transparent: true, 
      depthWrite: true 
    });
    
    const spineMat = new THREE.MeshStandardMaterial({ 
      roughness: 0.42, 
      metalness: 0.04, 
      transparent: true, 
      depthWrite: true 
    });
    spineMat.map = createPublisherSpine(book.title, book.author, extractedColor, thickness);

    const backCoverMat = new THREE.MeshStandardMaterial({ 
      roughness: 0.45, 
      metalness: 0.03, 
      transparent: true, 
      depthWrite: true 
    });
    backCoverMat.map = createPublisherBackCover(
      book.title, 
      book.author, 
      book.review || 'No synopsis provided.', 
      book.isbn, 
      extractedColor
    );

    const frontMat = new THREE.MeshStandardMaterial({ 
      color: '#ffffff', 
      roughness: 0.48, 
      metalness: 0.02, 
      transparent: true, 
      depthWrite: true 
    });
    if (book.coverUrl) {
      new THREE.TextureLoader().load(book.coverUrl, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        frontMat.map = tex;
        frontMat.needsUpdate = true;
      });
    } else {
      frontMat.color.set(extractedColor);
    }

    const jacketTrimMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(extractedColor).multiplyScalar(0.7),
      roughness: 0.45,
      metalness: 0.06,
      transparent: true, 
      depthWrite: true 
    });

    const endpaperMat = new THREE.MeshStandardMaterial({
      color: '#eae3d2',
      roughness: 0.88,
      transparent: true, 
      depthWrite: true 
    });

    return {
      frontMat,
      backCoverMat,
      topBottomPageMat,
      foreEdgePageMat,
      spineMat,
      jacketTrimMat,
      endpaperMat,
      all: [frontMat, backCoverMat, topBottomPageMat, foreEdgePageMat, spineMat, jacketTrimMat, endpaperMat]
    };
  }, [book.coverUrl, book.title, book.author, book.review, book.isbn, extractedColor, thickness]);

  const paperbackMaterialArray = useMemo(() => [
    materials.frontMat,
    materials.backCoverMat,
    materials.topBottomPageMat,
    materials.topBottomPageMat,
    materials.spineMat,
    materials.foreEdgePageMat
  ], [materials]);

  const hardcoverDimensions = useMemo(() => {
    if (!isHardcover) return null;
    const boardThickness = 0.036;
    const overhangZ = 0.05;
    const spineWallThickness = 0.024;

    const zFore = -(depth / 2 + overhangZ);
    const zSpineBack = depth / 2 - spineWallThickness;
    const boardDepth = zSpineBack - zFore;
    const boardCenterZ = (zFore + zSpineBack) / 2;

    const pagesW = Math.max(thickness - boardThickness * 2 - 0.016, 0.06);
    const pagesH = pageHeight;
    const pagesD = depth - 0.05;
    const pagesZ = -(overhangZ * 0.4);

    const spineCenterZ = depth / 2 - spineWallThickness / 2;

    return {
      boardThickness,
      overhangY,
      overhangZ,
      jacketHeight: height,
      boardDepth,
      boardCenterZ,
      pagesW,
      pagesH,
      pagesD,
      pagesZ,
      spineWallThickness,
      spineCenterZ
    };
  }, [isHardcover, thickness, height, depth, pageHeight, overhangY]);

  const paperbackGeom = useMemo(() => {
    if (isHardcover) return null;
    return createPaperbackGeometry(thickness, height, depth);
  }, [isHardcover, thickness, height, depth]);

  const hardcoverSpineGeom = useMemo(() => {
    if (!isHardcover || !hardcoverDimensions) return null;
    return createHardcoverSpineGeometry(thickness, hardcoverDimensions.jacketHeight, hardcoverDimensions.spineWallThickness);
  }, [isHardcover, thickness, hardcoverDimensions]);

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    const dt = Math.min(delta, 0.05);

    if (isDeleting) {
      const sinkTarget = new THREE.Vector3(groupRef.current.position.x, defaultY - 0.6, -1.2);
      groupRef.current.position.lerp(sinkTarget, dt * 1.8);
      groupRef.current.scale.lerp(new THREE.Vector3(0.01, 0.01, 0.01), dt * 2.2);

      materials.all.forEach((m) => {
        m.opacity = THREE.MathUtils.lerp(m.opacity, 0, dt * 2.5);
      });
      groupRef.current.rotation.x = THREE.MathUtils.lerp(groupRef.current.rotation.x, -0.4, dt * 2);
      return;
    }

    if (isPlacing) {
      const holdPosition = new THREE.Vector3(-1.35, -0.75, 5.5);
      groupRef.current.position.lerp(holdPosition, dt * 7);

      const targetAimX = (placementMode === 'dpad' && ghostNormPos) ? ghostNormPos.x : pointerPos.current.x;
      const targetAimY = (placementMode === 'dpad' && ghostNormPos) ? ghostNormPos.y : pointerPos.current.y;

      const targetRotX = 0.22 + targetAimY * 0.16;
      const targetRotY = -0.45 - targetAimX * 1.4;
      const targetRotZ = 0.08 + targetAimX * 0.35;

      groupRef.current.rotation.x = THREE.MathUtils.lerp(groupRef.current.rotation.x, targetRotX, dt * 8);
      groupRef.current.rotation.y = THREE.MathUtils.lerp(groupRef.current.rotation.y, targetRotY, dt * 8);
      groupRef.current.rotation.z = THREE.MathUtils.lerp(groupRef.current.rotation.z, targetRotZ, dt * 8);
    } else if (isSelected) {
      const isSheetOpen = isMobile && showMobileDetails;

      if (groupRef.current.position.z < 1.75) {
        groupRef.current.position.z = 1.75;
      }

      const targetX = isMobile ? 0 : -0.7;
      const targetY = isMobile ? (isSheetOpen ? 1.26 : 0.42) : 0.48;
      const targetZ = isMobile ? 3.6 : 5.4;
      const targetScale = isMobile ? (isSheetOpen ? 0.58 : 0.76) : 1.0;

      const targetPos = new THREE.Vector3(targetX, targetY, targetZ);
      groupRef.current.position.lerp(targetPos, dt * 5.0);
      groupRef.current.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), dt * 5.0);

      if (!isDraggingInspect.current) {
        inspectRot.current.x = THREE.MathUtils.lerp(inspectRot.current.x, 0, dt * 7.5);
        inspectRot.current.y = THREE.MathUtils.lerp(inspectRot.current.y, 0, dt * 7.5);
      }

      const baseRotY = isFlipped ? Math.PI / 2 : -Math.PI / 2;
      const finalRotX = inspectRot.current.x;
      const finalRotY = baseRotY + inspectRot.current.y;
      const finalRotZ = -inspectRot.current.y * 0.12;

      groupRef.current.rotation.x = THREE.MathUtils.lerp(groupRef.current.rotation.x, finalRotX, dt * 9);
      groupRef.current.rotation.y = THREE.MathUtils.lerp(groupRef.current.rotation.y, finalRotY, dt * 9);
      groupRef.current.rotation.z = THREE.MathUtils.lerp(groupRef.current.rotation.z, finalRotZ, dt * 9);
    } else {
      groupRef.current.scale.lerp(new THREE.Vector3(1, 1, 1), dt * 4.5);

      const isElevated = !hasSelection && !isEditingOrAdding && !isPlacing && (isHovered || isHighlighted);
      const hoverY = isElevated ? defaultY + (isBrowseMode ? 0.48 : 0.38) : defaultY;
      const hoverZ = isElevated ? (isBrowseMode ? 1.55 : 0.85) : 0;
      const shelfPos = new THREE.Vector3(defaultX, hoverY, hoverZ);
      
      groupRef.current.position.lerp(shelfPos, dt * 8.0);

      const targetRotX = isElevated ? 0.12 : 0;
      groupRef.current.rotation.x = THREE.MathUtils.lerp(groupRef.current.rotation.x, targetRotX, dt * 7.0);
      groupRef.current.rotation.y = THREE.MathUtils.lerp(groupRef.current.rotation.y, 0, dt * 7.0);
      groupRef.current.rotation.z = THREE.MathUtils.lerp(groupRef.current.rotation.z, 0, delta * 7.0);
    }

    materials.all.forEach((m) => {
      const targetOpacity = hasSelection && !isSelected && !isPlacing ? 0.0 : 1.0;
      m.opacity = THREE.MathUtils.lerp(m.opacity, targetOpacity, dt * 6);
    });
  });

  return (
    <group
      ref={groupRef}
      onPointerOver={(e) => {
        if (isPlacing || isEditingOrAdding) return;
        e.stopPropagation();
        onHover();
      }}
      onPointerOut={() => {
        if (isPlacing || isEditingOrAdding) return;
        onUnhover();
      }}
      onPointerDown={(e) => {
        if (isDeleting || isPlacing) return;
        e.stopPropagation();

        if (isSelected) {
          isDraggingInspect.current = true;
          lastDragPos.current = { x: e.clientX, y: e.clientY };
        } else {
          inspectRot.current = { x: 0, y: 0 };
          onSelect();
        }
      }}
      onPointerMove={(e) => {
        if (isSelected && isDraggingInspect.current) {
          e.stopPropagation();
          const dx = e.clientX - lastDragPos.current.x;
          const dy = e.clientY - lastDragPos.current.y;
          inspectRot.current.y += dx * 0.0075;
          inspectRot.current.x += dy * 0.0075;
          lastDragPos.current = { x: e.clientX, y: e.clientY };
        }
      }}
      onPointerUp={(e) => {
        if (isSelected) {
          e.stopPropagation();
          isDraggingInspect.current = false;
        }
      }}
      onPointerCancel={() => {
        isDraggingInspect.current = false;
      }}
    >
      {!isHardcover && paperbackGeom && (
        <mesh
          geometry={paperbackGeom}
          material={paperbackMaterialArray}
          castShadow
          receiveShadow
        />
      )}

      {isHardcover && hardcoverDimensions && (
        <group>
          <mesh
            position={[0, 0, hardcoverDimensions.pagesZ]}
            material={[
              materials.endpaperMat,
              materials.endpaperMat,
              materials.topBottomPageMat,
              materials.topBottomPageMat,
              materials.endpaperMat,
              materials.foreEdgePageMat
            ]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[hardcoverDimensions.pagesW, hardcoverDimensions.pagesH, hardcoverDimensions.pagesD]} />
          </mesh>

          <mesh
            position={[(thickness / 2) - (hardcoverDimensions.boardThickness / 2), 0, hardcoverDimensions.boardCenterZ]}
            material={[
              materials.frontMat,
              materials.endpaperMat,
              materials.jacketTrimMat,
              materials.jacketTrimMat,
              materials.jacketTrimMat,
              materials.jacketTrimMat
            ]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[hardcoverDimensions.boardThickness, hardcoverDimensions.jacketHeight, hardcoverDimensions.boardDepth]} />
          </mesh>

          <mesh
            position={[-(thickness / 2) + (hardcoverDimensions.boardThickness / 2), 0, hardcoverDimensions.boardCenterZ]}
            material={[
              materials.endpaperMat,
              materials.backCoverMat,
              materials.jacketTrimMat,
              materials.jacketTrimMat,
              materials.jacketTrimMat,
              materials.jacketTrimMat
            ]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[hardcoverDimensions.boardThickness, hardcoverDimensions.jacketHeight, hardcoverDimensions.boardDepth]} />
          </mesh>

          {hardcoverSpineGeom && (
            <mesh
              position={[0, 0, hardcoverDimensions.spineCenterZ]}
              geometry={hardcoverSpineGeom}
              material={[
                materials.jacketTrimMat,
                materials.jacketTrimMat,
                materials.jacketTrimMat,
                materials.jacketTrimMat,
                materials.spineMat,
                materials.jacketTrimMat
              ]}
              castShadow
              receiveShadow
            />
          )}
        </group>
      )}
    </group>
  );
}

function DropdownBookItem({ 
  book, 
  isHighlighted, 
  onHover, 
  onLeave, 
  onClick 
}: { 
  book: SavedBook; 
  isHighlighted: boolean; 
  onHover: () => void; 
  onLeave: () => void; 
  onClick: () => void; 
}) {
  const [spineColor, setSpineColor] = useState<string>(book.color || '#2c3e50');

  useEffect(() => {
    if (!book.coverUrl) return;
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.src = book.coverUrl;
    img.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = 16;
        cv.height = 16;
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, 16, 16);
        const p = ctx.getImageData(1, 1, 1, 1).data;
        const hex = `#${((1 << 24) + (p[0] << 16) + (p[1] << 8) + p[2]).toString(16).slice(1)}`;
        setSpineColor(hex);
      } catch (e) {}
    };
  }, [book.coverUrl]);

  const formattedDate = useMemo(() => {
    if (!book.dateAdded) return '';
    return new Date(book.dateAdded).toLocaleDateString(undefined, {
      month: 'short', 
      day: 'numeric', 
      year: 'numeric'
    });
  }, [book.dateAdded]);

  return (
    <div
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={onClick}
      style={{
        display: 'flex', 
        alignItems: 'center', 
        gap: 12, 
        padding: '10px 14px', 
        borderRadius: 12, 
        cursor: 'pointer', 
        background: isHighlighted ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.03)', 
        border: '1px solid', 
        borderColor: isHighlighted ? 'rgba(255, 255, 255, 0.2)' : 'transparent', 
        transition: 'all 0.15s ease', 
        marginBottom: 4
      }}
    >
      <div style={{ 
        width: 10, 
        height: 32, 
        borderRadius: 3, 
        background: spineColor, 
        flexShrink: 0, 
        boxShadow: `0 2px 8px ${spineColor}66`
      }} />
      <div style={{ overflow: 'hidden', flex: 1 }}>
        <div style={{ color: '#f3f4f6', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {book.title}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ color: '#9ca3af', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {book.author}
          </span>
          {formattedDate && (
            <span style={{ color: '#6b7280', fontSize: 10 }}>• Added {formattedDate}</span>
          )}
        </div>
      </div>
      <span style={{ fontSize: 11, color: '#ffffff', fontWeight: 600 }}>★ {book.rating}</span>
    </div>
  );
}

function SceneThemeController({ 
  theme, 
  themeProgress 
}: { 
  theme: 'dark' | 'light'; 
  themeProgress: React.MutableRefObject<number>;
}) {
  useFrame(({ gl }, delta) => {
    const target = theme === 'light' ? 1.0 : 0.0;
    const dt = Math.min(delta, 0.05);
    themeProgress.current = THREE.MathUtils.damp(themeProgress.current, target, 4.5, dt);

    const darkBg = new THREE.Color('#0a0a0c');
    const lightBg = new THREE.Color('#f5f2eb');
    const currentClearColor = new THREE.Color().lerpColors(darkBg, lightBg, themeProgress.current);
    gl.setClearColor(currentClearColor);
  });

  return null;
}

export default function App() {
  const books = useLiveQuery(() => db.books.toArray()) ?? [];
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const themeProgress = useRef<number>(0);

  // App Initial Boot Loading State
  const [isLoading, setIsLoading] = useState(true);
  const [loadingFadeOut, setLoadingFadeOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setLoadingFadeOut(true);
      setTimeout(() => setIsLoading(false), 650);
    }, 1200);
    return () => clearTimeout(timer);
  }, []);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isFlipped, setIsFlipped] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isScanningCamera, setIsScanningCamera] = useState(false);
  const [manualIsbn, setManualIsbn] = useState('');
  const [personalNotes, setPersonalNotes] = useState('');
  const [rating, setRating] = useState(5);
  const [hoverRating, setHoverRating] = useState<number | null>(null);
  const [isSearchingIsbn, setIsSearchingIsbn] = useState(false);

  const [resolvedBook, setResolvedBook] = useState<ResolvedBookData | null>(null);
  const [fallbackPages, setFallbackPages] = useState<string>('');
  const [fallbackFormat, setFallbackFormat] = useState<string>('Paperback');

  const [editingBook, setEditingBook] = useState<SavedBook | null>(null);
  const [hoveredPlacement, setHoveredPlacement] = useState<{ row: number; slot: number } | null>(null);
  const [placementMode, setPlacementMode] = useState<'glide' | 'dpad'>('glide');
  const [isDraggingShelf, setIsDraggingShelf] = useState(false);

  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [dropdownSearch, setDropdownSearch] = useState('');
  const [highlightedBookId, setHighlightedBookId] = useState<number | null>(null);
  const [hoveredBookId, setHoveredBookId] = useState<number | null>(null);

  const [isBrowseMode, setIsBrowseMode] = useState(false);
  const [browseFloat, setBrowseFloat] = useState(0);
  const isUserInteracting = useRef(false);

  const [isIdle, setIsIdle] = useState(false);
  const lastActivityRef = useRef(Date.now());
  const lastPointerCoords = useRef({ x: 0, y: 0 });

  const [showMobileDetails, setShowMobileDetails] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Settings Menu Navigation & Audio States
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsView, setSettingsView] = useState<'menu' | 'audio'>('menu');
  const [bgMusicEnabled, setBgMusicEnabled] = useState(true);
  const [bgMusicVolume, setBgMusicVolume] = useState(0.55);
  const [sfxEnabled, setSfxEnabled] = useState(true);
  const [sfxVolume, setSfxVolume] = useState(0.75);

  const [windowWidth, setWindowWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1200);

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const isMobile = windowWidth <= 640;

  const controlsRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement>(null!);
  const streamRef = useRef<MediaStream | null>(null);
  const pointerPos = useRef({ x: 0, y: 0 });
  const activeBook = books.find((b) => b.id === selectedId);

  const isSelected = selectedId !== null;
  const isEditingOrAdding = isModalOpen || editingBook !== null;
  const isHoldingPlacingBook = editingBook !== null && !isModalOpen;
  const totalShelves = Math.max(3, Math.ceil((books.length || 1) / BOOKS_PER_SHELF));

  useEffect(() => {
    const startAudio = () => {
      audioManager.resume();
      audioManager.setTheme(theme);
    };
    window.addEventListener('pointerdown', startAudio, { once: true });
    window.addEventListener('keydown', startAudio, { once: true });
    return () => {
      window.removeEventListener('pointerdown', startAudio);
      window.removeEventListener('keydown', startAudio);
    };
  }, [theme]);

  const prevBrowseIndexRef = useRef(Math.round(browseFloat));
  useEffect(() => {
    const curIdx = Math.round(browseFloat);
    if (isBrowseMode && prevBrowseIndexRef.current !== curIdx) {
      audioManager.playDeepSoftWhoosh();
      prevBrowseIndexRef.current = curIdx;
    }
  }, [isBrowseMode, browseFloat]);

  useEffect(() => {
    const resetIdleTimer = (e?: Event) => {
      if (e && e.type === 'pointermove') {
        const pe = e as PointerEvent;
        const dx = Math.abs(pe.clientX - lastPointerCoords.current.x);
        const dy = Math.abs(pe.clientY - lastPointerCoords.current.y);
        if (dx < 3 && dy < 3) return;
        lastPointerCoords.current = { x: pe.clientX, y: pe.clientY };
      }

      lastActivityRef.current = Date.now();
      setIsIdle(false);
    };

    const events = ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'keydown', 'wheel'];
    events.forEach((ev) => window.addEventListener(ev, resetIdleTimer, { passive: true }));

    const checkInterval = setInterval(() => {
      const activeInteracting = isSelected || isModalOpen || isHoldingPlacingBook || isBrowseMode;
      if (activeInteracting) {
        lastActivityRef.current = Date.now();
        setIsIdle(false);
      } else {
        if (Date.now() - lastActivityRef.current > 10000) {
          setIsIdle(true);
        }
      }
    }, 400);

    return () => {
      events.forEach((ev) => window.removeEventListener(ev, resetIdleTimer));
      clearInterval(checkInterval);
    };
  }, [isSelected, isModalOpen, isHoldingPlacingBook, isBrowseMode]);

  useEffect(() => {
    if (editingBook) {
      setHoveredPlacement({
        row: editingBook.shelfRow ?? 0,
        slot: editingBook.shelfIndex ?? 0
      });
    }
  }, [editingBook]);

  const handleDPadMove = (dRow: number, dSlot: number) => {
    audioManager.playButtonHum();
    setHoveredPlacement((curr) => {
      const curRow = curr?.row ?? 0;
      const curSlot = curr?.slot ?? 0;

      const newRow = THREE.MathUtils.clamp(curRow + dRow, 0, totalShelves - 1);
      const rowBooks = books.filter(b => (b.shelfRow ?? 0) === newRow && b.id !== editingBook?.id);
      const maxSlot = rowBooks.length;

      const newSlot = dRow !== 0 ? Math.min(curSlot, maxSlot) : THREE.MathUtils.clamp(curSlot + dSlot, 0, maxSlot);
      return { row: newRow, slot: newSlot };
    });
  };

  const sortedBooks = useMemo(() => {
    return [...books].sort((a, b) => {
      if ((a.shelfRow ?? 0) !== (b.shelfRow ?? 0)) {
        return (a.shelfIndex ?? 0) - (b.shelfIndex ?? 0);
      }
      return (a.shelfIndex ?? 0) - (b.shelfIndex ?? 0);
    });
  }, [books]);

  useEffect(() => {
    if (sortedBooks.length > 0 && browseFloat >= sortedBooks.length) {
      setBrowseFloat(sortedBooks.length - 1);
    }
  }, [sortedBooks.length, browseFloat]);

  const activeBrowseIndex = Math.round(browseFloat);
  const browsedBook = sortedBooks[activeBrowseIndex] ?? null;

  const filteredBooks = useMemo(() => {
    if (!dropdownSearch.trim()) return books;
    const q = dropdownSearch.toLowerCase().trim();
    return books.filter(b => 
      b.title.toLowerCase().includes(q) || 
      b.author.toLowerCase().includes(q) || 
      b.isbn.toLowerCase().includes(q)
    );
  }, [books, dropdownSearch]);

  const bookShelfPositions = useMemo(() => {
    const positionsMap = new Map<number, { x: number; row: number }>();

    for (let r = 0; r < totalShelves; r++) {
      const rowBooks = books
        .filter(b => (b.shelfRow ?? 0) === r && b.id !== editingBook?.id)
        .sort((a, b) => (a.shelfIndex ?? 0) - (b.shelfIndex ?? 0));

      const isHoveredRow = isEditingOrAdding && hoveredPlacement?.row === r;
      const insertIdx = isHoveredRow ? hoveredPlacement.slot : -1;
      const ghostW = editingBook ? getBookDimensions(editingBook).thickness : 0.35;

      const thicknesses = rowBooks.map(b => getBookDimensions(b).thickness);
      let totalW = thicknesses.reduce((acc, t) => acc + t, 0) + Math.max(0, rowBooks.length - 1) * BOOK_GAP;
      if (isHoveredRow) {
        totalW += ghostW + (rowBooks.length > 0 ? BOOK_GAP : 0);
      }

      let runX = -totalW / 2;
      for (let i = 0; i <= rowBooks.length; i++) {
        if (isHoveredRow && i === insertIdx) {
          runX += ghostW + BOOK_GAP;
        }
        if (i < rowBooks.length) {
          const b = rowBooks[i];
          const t = thicknesses[i];
          const bookX = runX + t / 2;
          if (b.id !== undefined) {
            positionsMap.set(b.id, { x: bookX, row: r });
          }
          runX += t + BOOK_GAP;
        }
      }
    }

    return positionsMap;
  }, [books, totalShelves, isEditingOrAdding, hoveredPlacement, editingBook]);

  const ghostNormPos = useMemo(() => {
    if (!isHoldingPlacingBook || !hoveredPlacement) return null;
    const r = hoveredPlacement.row;
    const slot = hoveredPlacement.slot;

    const rowBooks = books
      .filter(b => (b.shelfRow ?? 0) === r && b.id !== editingBook?.id)
      .sort((a, b) => (a.shelfIndex ?? 0) - (b.shelfIndex ?? 0));

    const thicknesses = rowBooks.map(b => getBookDimensions(b).thickness);
    const ghostW = editingBook ? getBookDimensions(editingBook).thickness : 0.35;
    const totalW = thicknesses.reduce((acc, t) => acc + t, 0) + Math.max(0, rowBooks.length - 1) * BOOK_GAP + ghostW;

    let runX = -totalW / 2;
    let gx = 0;
    for (let i = 0; i <= rowBooks.length; i++) {
      if (i === slot) {
        gx = runX + ghostW / 2;
        break;
      }
      if (i < rowBooks.length) {
        runX += thicknesses[i] + BOOK_GAP;
      }
    }

    const normX = THREE.MathUtils.clamp(gx / (SHELF_WIDTH / 2), -1, 1);
    const normY = THREE.MathUtils.clamp(((r - (totalShelves - 1) / 2) / (totalShelves / 2)), -1, 1);
    return { x: normX, y: normY };
  }, [isHoldingPlacingBook, hoveredPlacement, books, editingBook, totalShelves]);

  const browsedTargetPos = useMemo(() => {
    if (sortedBooks.length === 0) return null;
    const i0 = Math.floor(browseFloat);
    const i1 = Math.min(i0 + 1, sortedBooks.length - 1);
    const frac = browseFloat - i0;

    const b0 = sortedBooks[i0];
    const b1 = sortedBooks[i1];
    if (!b0 || !b1 || b0.id === undefined || b1.id === undefined) return null;

    const pos0 = bookShelfPositions.get(b0.id) || { x: 0, row: 0 };
    const pos1 = bookShelfPositions.get(b1.id) || { x: 0, row: 0 };

    const shelfTopY0 = (pos0.row - (totalShelves - 1) / 2) * SHELF_HEIGHT_GAP - 1.25 + SHELF_THICKNESS / 2;
    const shelfTopY1 = (pos1.row - (totalShelves - 1) / 2) * SHELF_HEIGHT_GAP - 1.25 + SHELF_THICKNESS / 2;

    const y0 = shelfTopY0 + getBookDimensions(b0).height / 2;
    const y1 = shelfTopY1 + getBookDimensions(b1).height / 2;

    return {
      x: THREE.MathUtils.lerp(pos0.x, pos1.x, frac),
      y: THREE.MathUtils.lerp(y0, y1, frac)
    };
  }, [sortedBooks, browseFloat, bookShelfPositions, totalShelves]);

  const effectiveHoveredId = isBrowseMode && browsedBook && !isSelected ? browsedBook.id : hoveredBookId;

  const stopCameraStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsScanningCamera(false);
    setCameraError(null);
  };

  useEffect(() => {
    if (!isScanningCamera) return;

    let isMounted = true;
    const codeReader = new BrowserMultiFormatReader();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError('Camera access requires HTTPS or localhost on iOS.');
      return;
    }

    navigator.mediaDevices.getUserMedia({ 
      video: { 
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    })
      .then((stream) => {
        if (!isMounted) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.setAttribute('playsinline', 'true');
          videoRef.current.setAttribute('muted', 'true');
          videoRef.current.play().catch(() => {});
        }

        codeReader.decodeFromVideoElement(videoRef.current, (result) => {
          if (result) {
            const cleaned = result.getText().replace(/[-\s]/g, '');
            stopCameraStream();
            setManualIsbn(cleaned);
            audioManager.playButtonHum();
          }
        }).catch(() => {});
      })
      .catch((err) => {
        console.error('Camera error:', err);
        setCameraError('Camera blocked. On iPhone local Wi-Fi (HTTP), iOS restricts video access. Enter ISBN manually below.');
      });

    return () => {
      isMounted = false;
      stopCameraStream();
    };
  }, [isScanningCamera]);

  const handleLookupIsbn = async () => {
    if (!manualIsbn.trim()) return;
    audioManager.playButtonHum();
    setIsSearchingIsbn(true);
    setResolvedBook(null);

    try {
      const cleanIsbn = manualIsbn.replace(/[^0-9X]/gi, '').trim();
      const isbnVariants = getIsbnVariants(cleanIsbn);

      const [olEdResults, olSearchResults, gbResults] = await Promise.all([
        Promise.allSettled(isbnVariants.map(v => fetch(`https://openlibrary.org/isbn/${v}.json`).then(r => r.ok ? r.json() : null))),
        Promise.allSettled(isbnVariants.map(v => fetch(`https://openlibrary.org/search.json?q=${v}&limit=2`).then(r => r.ok ? r.json() : null))),
        Promise.allSettled(isbnVariants.map(v => fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${v}`).then(r => r.ok ? r.json() : null)))
      ]);

      const olEd = olEdResults.map(r => r.status === 'fulfilled' ? r.value : null).find(Boolean);
      const olSearchDoc = olSearchResults.map(r => r.status === 'fulfilled' ? r.value?.docs?.[0] : null).find(Boolean);
      const gbVolumes = gbResults.map(r => r.status === 'fulfilled' ? r.value?.items : null).flat().filter(Boolean);
      let gbItem = gbVolumes.find((v: any) => v.volumeInfo?.pageCount || v.volumeInfo?.dimensions) || gbVolumes[0];

      if (gbItem?.id && (!gbItem.volumeInfo?.dimensions || !gbItem.volumeInfo?.pageCount)) {
        try {
          const deepRes = await fetch(`https://www.googleapis.com/books/v1/volumes/${gbItem.id}`);
          if (deepRes.ok) {
            const deepData = await deepRes.json();
            if (deepData.volumeInfo) gbItem = deepData;
          }
        } catch (e) {}
      }

      let title = olEd?.title || gbItem?.volumeInfo?.title || olSearchDoc?.title || 'Unknown Title';
      const subtitle = gbItem?.volumeInfo?.subtitle;
      if (subtitle && !title.toLowerCase().includes(subtitle.toLowerCase())) {
        title = `${title}: ${subtitle}`;
      }

      const isCJK = (str: string) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(str);
      let author = '';
      if (olSearchDoc?.author_name?.length) {
        author = olSearchDoc.author_name.join(', ');
      }
      if (!author || isCJK(author)) {
        const gbAuthors = gbItem?.volumeInfo?.authors;
        if (gbAuthors?.length) {
          const joined = gbAuthors.join(', ');
          if (!isCJK(joined) || !author) author = joined;
        }
      }
      if (!author && olEd?.authors?.length) {
        try {
          const authKey = olEd.authors[0].key;
          const authRes = await fetch(`https://openlibrary.org${authKey}.json`);
          if (authRes.ok) {
            const authJson = await authRes.json();
            if (authJson.name) author = authJson.name;
          }
        } catch (e) {}
      }
      if (!author) author = 'Unknown Author';

      let pageCount: number | undefined = undefined;
      if (olEd?.number_of_pages && Number(olEd.number_of_pages) > 0) {
        pageCount = Number(olEd.number_of_pages);
      } else if (gbItem?.volumeInfo?.pageCount && Number(gbItem.volumeInfo.pageCount) > 0) {
        pageCount = Number(gbItem.volumeInfo.pageCount);
      } else if (gbItem?.volumeInfo?.printedPageCount && Number(gbItem.volumeInfo.printedPageCount) > 0) {
        pageCount = Number(gbItem.volumeInfo.printedPageCount);
      } else if (olSearchDoc?.number_of_pages_median && Number(olSearchDoc.number_of_pages_median) > 0) {
        pageCount = Number(olSearchDoc.number_of_pages_median);
      }

      if (!pageCount && olEd?.pagination) {
        const match = String(olEd.pagination).match(/(\d+)\s*(?:p|pages)?/i);
        if (match) pageCount = parseInt(match[1], 10);
      }

      if (!pageCount && olEd?.works?.[0]?.key) {
        try {
          const workRes = await fetch(`https://openlibrary.org${olEd.works[0].key}/editions.json?limit=5`);
          if (workRes.ok) {
            const workData = await workRes.json();
            for (const ed of workData.entries || []) {
              if (ed.number_of_pages && Number(ed.number_of_pages) > 0) {
                pageCount = Number(ed.number_of_pages);
                break;
              }
            }
          }
        } catch (e) {}
      }

      let format: string | undefined = undefined;
      const rawFormat = (olEd?.physical_format || gbItem?.volumeInfo?.printType || '').toLowerCase();
      if (rawFormat.includes('hard') || rawFormat.includes('bound')) {
        format = 'Hardcover';
      } else if (rawFormat.includes('paper') || rawFormat.includes('pocket') || rawFormat.includes('mass')) {
        format = 'Paperback';
      }

      let customHeight: number | undefined = undefined;
      let customDepth: number | undefined = undefined;
      let customThickness: number | undefined = undefined;

      const gbDim = gbItem?.volumeInfo?.dimensions;
      if (gbDim) {
        const h = parseDimensionUnit(gbDim.height);
        const w = parseDimensionUnit(gbDim.width);
        const t = parseDimensionUnit(gbDim.thickness);
        if (h) customHeight = THREE.MathUtils.clamp(h / 10, 1.75, 2.75);
        if (w) customDepth = THREE.MathUtils.clamp(w / 10, 1.25, 1.95);
        if (t) customThickness = THREE.MathUtils.clamp(t / 10, 0.12, 0.95);
      }

      if (!customHeight && olEd?.physical_dimensions) {
        const parsed = parseThreePartDimensions(olEd.physical_dimensions);
        if (parsed) {
          customHeight = THREE.MathUtils.clamp(parsed.heightCm / 10, 1.75, 2.75);
          customDepth = THREE.MathUtils.clamp(parsed.depthCm / 10, 1.25, 1.95);
          if (parsed.thicknessCm) {
            customThickness = THREE.MathUtils.clamp(parsed.thicknessCm / 10, 0.12, 0.95);
          }
        }
      }

      let coverUrl = `https://covers.openlibrary.org/b/isbn/${cleanIsbn}-L.jpg`;
      if (gbItem?.volumeInfo?.imageLinks) {
        const primary = gbItem.volumeInfo.imageLinks.extraLarge || 
                        gbItem.volumeInfo.imageLinks.large || 
                        gbItem.volumeInfo.imageLinks.medium || 
                        gbItem.volumeInfo.imageLinks.thumbnail;
        if (primary) coverUrl = primary.replace('&edge=curl', '').replace('http://', 'https://');
      }

      const blurb = gbItem?.volumeInfo?.description || olEd?.description?.value || olEd?.description || '';

      setResolvedBook({
        title,
        author,
        isbn: cleanIsbn,
        coverUrl,
        blurb,
        pageCount,
        format,
        customHeight,
        customDepth,
        customThickness
      });

      setFallbackPages(pageCount ? String(pageCount) : '');
      setFallbackFormat(format || 'Paperback');
    } catch (err) {
      console.error('Lookup failed:', err);
      alert('Could not locate edition information. You can enter details manually.');
    } finally {
      setIsSearchingIsbn(false);
    }
  };

  const handleConfirmSave = async () => {
    if (!resolvedBook) return;
    audioManager.playButtonHum();

    const finalPageCount = parseInt(fallbackPages, 10) > 0 
      ? parseInt(fallbackPages, 10) 
      : (resolvedBook.pageCount || 300);

    const finalFormat = fallbackFormat || resolvedBook.format || 'Paperback';

    const newId = await db.books.add({
      title: resolvedBook.title,
      author: resolvedBook.author,
      isbn: resolvedBook.isbn,
      coverUrl: resolvedBook.coverUrl,
      color: theme === 'light' ? '#8a5c38' : '#1e293b',
      rating,
      review: resolvedBook.blurb || personalNotes || 'No publisher synopsis recorded.',
      pageCount: finalPageCount,
      shelfRow: 0,
      shelfIndex: 0,
      dateAdded: Date.now(),
      ...(resolvedBook.customHeight ? { customHeight: resolvedBook.customHeight } : {}),
      ...(resolvedBook.customDepth ? { customDepth: resolvedBook.customDepth } : {}),
      ...(resolvedBook.customThickness ? { customThickness: resolvedBook.customThickness } : {}),
      format: finalFormat,
    });

    const newlyAdded = await db.books.get(newId);

    setPersonalNotes('');
    setManualIsbn('');
    setResolvedBook(null);
    setFallbackPages('');
    setFallbackFormat('Paperback');
    setRating(5);
    setHoverRating(null);
    setIsModalOpen(false);

    if (newlyAdded) {
      setEditingBook(newlyAdded);
    }
  };

  const handleMoveBook = async (bookToMove: SavedBook, newRow: number, newSlot: number) => {
    if (!bookToMove.id) return;
    const oldRow = bookToMove.shelfRow ?? 0;
    const allBooks = await db.books.toArray();

    const targetOtherBooks = allBooks
      .filter(b => b.id !== bookToMove.id && (b.shelfRow ?? 0) === newRow)
      .sort((a, b) => (a.shelfIndex ?? 0) - (b.shelfIndex ?? 0));

    targetOtherBooks.splice(newSlot, 0, bookToMove);

    for (let i = 0; i < targetOtherBooks.length; i++) {
      const b = targetOtherBooks[i];
      if (b.id === bookToMove.id) {
        await db.books.update(b.id, { shelfRow: newRow, shelfIndex: i });
      } else if (b.shelfIndex !== i || b.shelfRow !== newRow) {
        await db.books.update(b.id!, { shelfIndex: i });
      }
    }

    if (oldRow !== newRow) {
      const oldShelfBooks = allBooks
        .filter(b => b.id !== bookToMove.id && (b.shelfRow ?? 0) === oldRow)
        .sort((a, b) => (a.shelfIndex ?? 0) - (b.shelfIndex ?? 0));
      for (let i = 0; i < oldShelfBooks.length; i++) {
        if (oldShelfBooks[i].shelfIndex !== i) {
          await db.books.update(oldShelfBooks[i].id!, { shelfIndex: i });
        }
      }
    }

    setHoveredPlacement(null);
  };

  const handleConfirmPlacement = async (row: number, slot: number) => {
    if (editingBook) {
      audioManager.playThump();
      const bookToMove = editingBook;
      setEditingBook(null);
      await handleMoveBook(bookToMove, row, slot);
    }
  };

  const handleDeleteBook = (id?: number) => {
    if (!id) return;
    audioManager.playButtonHum();
    setSelectedId(null);
    setIsFlipped(false);
    setShowMobileDetails(false);
    setDeletingId(id);

    setTimeout(async () => {
      await db.books.delete(id);
      setDeletingId(null);
    }, 1100);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const x = (e.clientX / window.innerWidth) * 2 - 1;
    const y = -(e.clientY / window.innerHeight) * 2 + 1;
    pointerPos.current = { x, y };
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length > 0) {
      const touch = e.touches[0];
      const x = (touch.clientX / window.innerWidth) * 2 - 1;
      const y = -(touch.clientY / window.innerHeight) * 2 + 1;
      pointerPos.current = { x, y };
    }
  };

  const isLight = theme === 'light';

  const uiPillBg = isLight ? 'rgba(24, 21, 19, 0.88)' : 'rgba(15, 20, 28, 0.65)';
  const uiPillBorder = isLight ? '1px solid rgba(255, 255, 255, 0.16)' : '1px solid rgba(255, 255, 255, 0.22)';
  const uiPillShadow = isLight 
    ? '0 12px 32px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.22)' 
    : '0 12px 28px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.25)';

  return (
    <div 
      onPointerMove={handlePointerMove}
      onTouchMove={handleTouchMove}
      style={{ 
        width: '100vw', 
        height: '100dvh', 
        position: 'fixed',
        inset: 0,
        margin: 0,
        padding: 0,
        background: isLight ? '#f5f2eb' : '#0a0a0c', 
        overflow: 'hidden',
        touchAction: 'none',
        transition: 'background 0.5s cubic-bezier(0.4, 0, 0.2, 1)'
      }}
    >
      <style>{`
        html, body, #root {
          width: 100%;
          height: 100%;
          margin: 0;
          padding: 0;
          overflow: hidden;
          background-color: ${isLight ? '#f5f2eb' : '#0a0a0c'};
          -webkit-user-select: none;
          user-select: none;
        }
        .seamless-glass-scroll {
          scrollbar-width: thin;
          scrollbar-color: rgba(255, 255, 255, 0.16) transparent;
        }
        .seamless-glass-scroll::-webkit-scrollbar {
          width: 5px;
        }
        .seamless-glass-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .seamless-glass-scroll::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.14);
          border-radius: 9999px;
        }
        .seamless-glass-scroll::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.28);
        }
        input[type=range].browse-slider {
          -webkit-appearance: none;
          appearance: none;
          background: rgba(255, 255, 255, 0.16);
          height: 6px;
          border-radius: 999px;
          outline: none;
          touch-action: pan-x;
        }
        input[type=range].browse-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 26px;
          height: 26px;
          border-radius: 50%;
          background: #ffffff;
          box-shadow: 0 2px 10px rgba(0,0,0,0.55);
          cursor: pointer;
          border: 2px solid rgba(0, 0, 0, 0.2);
        }
      `}</style>

      {/* Initial Dark Blue Loading Screen */}
      {isLoading && (
        <div 
          style={{
            position: 'fixed',
            inset: 0,
            background: '#0a1128',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            opacity: loadingFadeOut ? 0 : 1,
            transition: 'opacity 0.65s cubic-bezier(0.4, 0, 0.2, 1)',
            pointerEvents: loadingFadeOut ? 'none' : 'all'
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
            <svg 
              width="68" 
              height="68" 
              viewBox="0 0 48 48" 
              fill="none" 
              stroke="#ffffff" 
              strokeWidth="2.4" 
              strokeLinecap="round" 
              strokeLinejoin="round"
              style={{ filter: 'drop-shadow(0 4px 16px rgba(255,255,255,0.35))' }}
            >
              <path d="M6 6v36" />
              <path d="M42 6v36" />
              <path d="M6 18h36" />
              <path d="M6 32h36" />
              <path d="M6 42h36" />
              {/* Books on Shelves */}
              <path d="M12 18V9h4v9" />
              <path d="M16 18V9h4v9" />
              <path d="M22 18l4-8h4l-4 8" />
              <path d="M28 32v-10h4v10" />
              <path d="M32 32v-10h4v10" />
              <path d="M13 32l-3-9h4l3 9" />
            </svg>
            <div style={{ 
              color: 'rgba(255, 255, 255, 0.85)', 
              fontSize: 13, 
              fontWeight: 600,
              letterSpacing: '0.24em', 
              textTransform: 'uppercase',
              fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
            }}>
              Shelf
            </div>
          </div>
        </div>
      )}

      {/* Top Navbar: Fullscreen Edge-To-Edge with Native Notch Safe Inset */}
      <div 
        onPointerEnter={() => {
          setHoveredBookId(null);
          setHighlightedBookId(null);
          document.body.style.cursor = 'default';
        }}
        style={{
          position: 'absolute',
          top: 'calc(env(safe-area-inset-top, 0px) + 16px)',
          left: isMobile ? 16 : 32,
          right: isMobile ? 16 : 32,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          zIndex: 40
        }}
      >
        <div style={{ position: 'relative' }}>
          <button
            onMouseEnter={() => {
              setHoveredBookId(null);
              setHighlightedBookId(null);
              document.body.style.cursor = 'default';
            }}
            onClick={() => {
              audioManager.playButtonHum();
              setIsDropdownOpen(!isDropdownOpen);
              setHighlightedBookId(null);
              setDropdownSearch('');
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: uiPillBg,
              backdropFilter: 'blur(28px) saturate(200%)',
              border: uiPillBorder,
              padding: isMobile ? '6px 12px' : '8px 16px',
              borderRadius: 14,
              cursor: 'pointer',
              color: '#f3f4f6',
              boxShadow: uiPillShadow,
              transition: 'all 0.3s ease'
            }}
          >
            <span style={{ fontSize: isMobile ? 17 : 20, fontWeight: 700, fontFamily: 'Georgia, serif' }}>Library</span>
            <span style={{ fontSize: 11, color: '#d1d5db', background: 'rgba(255, 255, 255, 0.12)', padding: '2px 8px', borderRadius: 8 }}>
              {books.length} {books.length === 1 ? 'book' : 'books'}
            </span>
            <span style={{ fontSize: 10, transform: isDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s', color: '#9ca3af' }}>
              ▼
            </span>
          </button>

          {isDropdownOpen && (
            <div 
              onMouseLeave={() => setHighlightedBookId(null)}
              style={{
                position: 'absolute',
                top: 48,
                left: 0,
                width: isMobile ? Math.min(windowWidth - 32, 340) : 360,
                maxHeight: 440,
                display: 'flex',
                flexDirection: 'column',
                background: isLight ? 'rgba(24, 21, 19, 0.94)' : 'rgba(15, 18, 24, 0.65)',
                backdropFilter: 'blur(40px) saturate(220%)',
                border: uiPillBorder,
                borderRadius: 22,
                padding: '12px',
                boxShadow: '0 25px 60px rgba(0, 0, 0, 0.85), inset 0 1px 0 rgba(255, 255, 255, 0.25)',
                zIndex: 50,
                boxSizing: 'border-box'
              }}
            >
              <div style={{ marginBottom: 10 }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: '1px solid rgba(255, 255, 255, 0.16)',
                  borderRadius: 12,
                  boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.25)'
                }}>
                  <span style={{ fontSize: 13, color: '#9ca3af', userSelect: 'none' }}>🔍</span>
                  <input
                    type="text"
                    placeholder="Search titles, authors, ISBN..."
                    value={dropdownSearch}
                    onChange={(e) => setDropdownSearch(e.target.value)}
                    style={{
                      width: '100%',
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      color: '#f3f4f6',
                      fontSize: '16px',
                      fontFamily: 'inherit'
                    }}
                  />
                  {dropdownSearch && (
                    <button
                      onClick={() => {
                        audioManager.playButtonHum();
                        setDropdownSearch('');
                      }}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#9ca3af',
                        cursor: 'pointer',
                        padding: 0,
                        fontSize: 16,
                        lineHeight: 1
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>

              <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                padding: '0 4px 8px 4px', 
                fontSize: 11, 
                fontWeight: 600, 
                color: '#9ca3af', 
                letterSpacing: '0.06em', 
                textTransform: 'uppercase' 
              }}>
                <span>Display Collection</span>
                <span>{filteredBooks.length} / {books.length}</span>
              </div>

              <div 
                className="seamless-glass-scroll"
                style={{
                  overflowY: 'auto',
                  maxHeight: 310,
                  paddingRight: 4
                }}
              >
                {filteredBooks.length === 0 ? (
                  <div style={{ padding: '24px 12px', fontSize: 13, color: '#6b7280', textAlign: 'center' }}>
                    {books.length === 0 ? 'No books added yet.' : 'No matching books found.'}
                  </div>
                ) : (
                  filteredBooks.map((b) => (
                    <DropdownBookItem
                      key={b.id}
                      book={b}
                      isHighlighted={highlightedBookId === b.id}
                      onHover={() => setHighlightedBookId(b.id ?? null)}
                      onLeave={() => setHighlightedBookId(null)}
                      onClick={() => {
                        audioManager.playDeepSoftWhoosh();
                        setSelectedId(b.id ?? null);
                        setIsDropdownOpen(false);
                        setHighlightedBookId(null);
                        setShowMobileDetails(false);
                      }}
                    />
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <button
          onClick={() => {
            audioManager.playButtonHum();
            setIsModalOpen(true);
            setIsDropdownOpen(false);
            setResolvedBook(null);
          }}
          style={{
            padding: isMobile ? '8px 14px' : '10px 18px',
            background: uiPillBg,
            color: '#f3f4f6',
            borderRadius: 12,
            border: uiPillBorder,
            fontWeight: 600,
            fontSize: isMobile ? 12 : 13,
            cursor: 'pointer',
            backdropFilter: 'blur(28px) saturate(200%)',
            boxShadow: uiPillShadow,
            transition: 'all 0.3s ease',
            fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
          }}
        >
          + Add Book
        </button>
      </div>

      {/* Floating Active Book Bubble in Browse Mode */}
      {isBrowseMode && browsedBook && !isSelected && !isHoldingPlacingBook && (
        <div 
          onClick={() => {
            audioManager.playDeepSoftWhoosh();
            setSelectedId(browsedBook.id!);
            setIsFlipped(false);
            setShowMobileDetails(false);
          }}
          style={{
            position: 'absolute',
            top: 'calc(env(safe-area-inset-top, 0px) + 72px)',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 45,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: uiPillBg,
            backdropFilter: 'blur(32px) saturate(200%)',
            border: uiPillBorder,
            boxShadow: uiPillShadow,
            padding: '10px 18px',
            borderRadius: 999,
            cursor: 'pointer',
            maxWidth: '90vw',
            transition: 'all 0.3s ease'
          }}
        >
          <div style={{ overflow: 'hidden', textAlign: 'center' }}>
            <div style={{
              color: '#fcf8f0',
              fontFamily: 'Georgia, serif',
              fontSize: isMobile ? 13 : 15,
              fontWeight: 700,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: isMobile ? 240 : 380
            }}>
              {browsedBook.title}
            </div>
            <div style={{ color: '#9ca3af', fontSize: 11, fontStyle: 'italic', marginTop: 1 }}>
              {browsedBook.author} • {'★'.repeat(browsedBook.rating)}
            </div>
          </div>
        </div>
      )}

      {/* Center Screen Prompt for Phone in Glide Mode */}
      {isHoldingPlacingBook && placementMode === 'glide' && isMobile && !isDraggingShelf && (
        <div style={{
          position: 'absolute',
          top: '38%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
          background: uiPillBg,
          backdropFilter: 'blur(35px) saturate(220%)',
          border: uiPillBorder,
          borderRadius: 20,
          padding: '12px 20px',
          color: '#fcf8f0',
          boxShadow: uiPillShadow,
          zIndex: 85,
          textAlign: 'center',
          maxWidth: '82vw',
          transition: 'opacity 0.2s ease'
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'Georgia, serif' }}>
            Hold and drag to select position
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af' }}>
            Release finger to place
          </div>
        </div>
      )}

      {/* Desktop Helper Banner in Glide Mode */}
      {isHoldingPlacingBook && placementMode === 'glide' && !isMobile && (
        <div style={{
          position: 'absolute',
          top: 86,
          left: '50%',
          transform: 'translateX(-50%)',
          pointerEvents: 'none',
          background: uiPillBg,
          backdropFilter: 'blur(20px)',
          border: uiPillBorder,
          borderRadius: 999,
          padding: '6px 16px',
          color: '#d1d5db',
          fontSize: 12,
          fontWeight: 500,
          zIndex: 85,
          transition: 'all 0.3s ease'
        }}>
          Move cursor over shelves to glide • Click to place
        </div>
      )}

      {/* D-Pad Directional Controller */}
      {isHoldingPlacingBook && placementMode === 'dpad' && (
        <div style={{
          position: 'absolute',
          bottom: isMobile ? 'calc(env(safe-area-inset-bottom, 16px) + 84px)' : 96,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          zIndex: 85
        }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 46px)',
            gridTemplateRows: 'repeat(3, 46px)',
            gap: 6,
            background: isLight ? 'rgba(24, 21, 19, 0.92)' : 'rgba(15, 20, 28, 0.65)',
            backdropFilter: 'blur(35px) saturate(220%)',
            padding: 8,
            borderRadius: 24,
            border: uiPillBorder,
            boxShadow: uiPillShadow,
            transition: 'all 0.3s ease'
          }}>
            <div />
            <button
              onClick={() => handleDPadMove(1, 0)}
              style={{
                background: 'rgba(255, 255, 255, 0.12)',
                border: '1px solid rgba(255, 255, 255, 0.25)',
                borderRadius: 14,
                color: '#ffffff',
                fontSize: 18,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              ▲
            </button>
            <div />

            <button
              onClick={() => handleDPadMove(0, -1)}
              style={{
                background: 'rgba(255, 255, 255, 0.12)',
                border: '1px solid rgba(255, 255, 255, 0.25)',
                borderRadius: 14,
                color: '#ffffff',
                fontSize: 18,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              ◀
            </button>

            <button
              onClick={async () => {
                if (editingBook && hoveredPlacement) {
                  await handleConfirmPlacement(hoveredPlacement.row, hoveredPlacement.slot);
                }
              }}
              title="Confirm Placement"
              style={{
                background: 'rgba(34, 197, 94, 0.32)',
                border: '1.5px solid rgba(74, 222, 128, 0.7)',
                borderRadius: '50%',
                color: '#ffffff',
                fontSize: 22,
                fontWeight: 'bold',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 0 15px rgba(22, 163, 74, 0.5), inset 0 1px 1px rgba(255, 255, 255, 0.8)'
              }}
            >
              ✓
            </button>

            <button
              onClick={() => handleDPadMove(0, 1)}
              style={{
                background: 'rgba(255, 255, 255, 0.12)',
                border: '1px solid rgba(255, 255, 255, 0.25)',
                borderRadius: 14,
                color: '#ffffff',
                fontSize: 18,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              ▶
            </button>

            <div />
            <button
              onClick={() => handleDPadMove(-1, 0)}
              style={{
                background: 'rgba(255, 255, 255, 0.12)',
                border: '1px solid rgba(255, 255, 255, 0.25)',
                borderRadius: 14,
                color: '#ffffff',
                fontSize: 18,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              ▼
            </button>
            <div />
          </div>
        </div>
      )}

      {/* Placement Mode Dock (Glide, D-Pad, Cancel) */}
      {isHoldingPlacingBook && (
        <div style={{
          position: 'absolute',
          bottom: isMobile ? 'calc(env(safe-area-inset-bottom, 16px) + 16px)' : 26,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          zIndex: 90
        }}>
          <button
            onClick={() => {
              audioManager.playButtonHum();
              setPlacementMode('glide');
            }}
            title="Glide Mode"
            style={{
              width: 52,
              height: 52,
              borderRadius: '50%',
              background: placementMode === 'glide' ? 'rgba(54, 48, 42, 0.95)' : uiPillBg,
              backdropFilter: 'blur(30px) saturate(220%)',
              border: placementMode === 'glide' ? '1.5px solid rgba(255, 255, 255, 0.85)' : uiPillBorder,
              boxShadow: placementMode === 'glide' 
                ? '0 0 20px rgba(255, 255, 255, 0.45), inset 0 1px 1px rgba(255, 255, 255, 0.8)' 
                : uiPillShadow,
              color: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.18s cubic-bezier(0.34, 1.56, 0.64, 1)',
              transform: placementMode === 'glide' ? 'scale(1.06)' : 'scale(1.0)'
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v9" />
              <path d="m9 5 3-3 3 3" />
              <path d="M7 11.5a2.5 2.5 0 0 1 5 0V12h1a2 2 0 0 1 2 2v1a2 2 0 0 1 2 2v1a5 5 0 0 1-10 0v-6.5Z" />
            </svg>
          </button>

          <button
            onClick={() => {
              audioManager.playButtonHum();
              setPlacementMode('dpad');
            }}
            title="D-Pad Mode"
            style={{
              width: 52,
              height: 52,
              borderRadius: '50%',
              background: placementMode === 'dpad' ? 'rgba(54, 48, 42, 0.95)' : uiPillBg,
              backdropFilter: 'blur(30px) saturate(220%)',
              border: placementMode === 'dpad' ? '1.5px solid rgba(255, 255, 255, 0.85)' : uiPillBorder,
              boxShadow: placementMode === 'dpad' 
                ? '0 0 20px rgba(255, 255, 255, 0.45), inset 0 1px 1px rgba(255, 255, 255, 0.8)' 
                : uiPillShadow,
              color: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.18s cubic-bezier(0.34, 1.56, 0.64, 1)',
              transform: placementMode === 'dpad' ? 'scale(1.06)' : 'scale(1.0)'
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 3l3 3.5h-2.2v3.7h-1.6V6.5H9L12 3z" />
              <path d="M12 21l-3-3.5h2.2v-3.7h1.6v3.7H15L12 21z" />
              <path d="M3 12l3.5-3v2.2h3.7v1.6H6.5V15L3 12z" />
              <path d="M21 12l-3.5 3v-2.2h-3.7v-1.6h3.7V9L21 12z" />
            </svg>
          </button>

          <button
            onClick={() => {
              audioManager.playButtonHum();
              if (isModalOpen) setIsModalOpen(false);
              if (editingBook) setEditingBook(null);
              setHoveredPlacement(null);
            }}
            title="Cancel Placement"
            style={{
              width: 52,
              height: 52,
              borderRadius: '50%',
              background: isLight ? 'rgba(70, 24, 24, 0.88)' : 'rgba(239, 68, 68, 0.16)',
              backdropFilter: 'blur(30px) saturate(220%)',
              border: isLight ? '1px solid rgba(248, 113, 113, 0.55)' : '1px solid rgba(248, 113, 113, 0.45)',
              boxShadow: uiPillShadow,
              color: '#f87171',
              fontSize: 20,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.18s ease'
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Bottom Left Mode Button (Dark / Light) */}
      {!isHoldingPlacingBook && !isSelected && (
        <button
          onClick={() => {
            audioManager.playButtonHum();
            setTheme((prev) => {
              const nextTheme = prev === 'dark' ? 'light' : 'dark';
              audioManager.setTheme(nextTheme);
              return nextTheme;
            });
          }}
          title={isLight ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
          style={{
            position: 'absolute',
            bottom: isMobile ? 'calc(env(safe-area-inset-bottom, 16px) + 16px)' : 34,
            left: isMobile ? 16 : 32,
            width: 52,
            height: 52,
            borderRadius: '50%',
            background: uiPillBg,
            backdropFilter: 'blur(30px) saturate(220%)',
            border: uiPillBorder,
            boxShadow: uiPillShadow,
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            zIndex: 45,
            transition: 'all 0.3s ease'
          }}
        >
          {isLight ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>
      )}

      {/* Settings Popup Window */}
      {isSettingsOpen && !isHoldingPlacingBook && !isSelected && (
        <div 
          onPointerDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            bottom: isMobile ? 'calc(env(safe-area-inset-bottom, 16px) + 78px)' : 96,
            right: isMobile ? 16 : 32,
            width: isMobile ? 'calc(100vw - 32px)' : 310,
            maxWidth: 320,
            background: uiPillBg,
            backdropFilter: 'blur(35px) saturate(220%)',
            border: uiPillBorder,
            borderRadius: 22,
            padding: '16px 18px',
            boxShadow: uiPillShadow,
            zIndex: 60,
            color: '#f3f4f6',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            {settingsView === 'menu' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.85 }}>
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l-.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#f3f4f6', fontFamily: 'inherit' }}>Settings</span>
              </div>
            ) : (
              <button
                onClick={() => {
                  audioManager.playButtonHum();
                  setSettingsView('menu');
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#f3f4f6',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: 0,
                  fontFamily: 'inherit'
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.85 }}>
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                <span>Sound Settings</span>
              </button>
            )}

            <button
              onClick={() => {
                audioManager.playButtonHum();
                setIsSettingsOpen(false);
              }}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#9ca3af',
                cursor: 'pointer',
                padding: '4px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Level 1: Category Picker */}
          {settingsView === 'menu' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button
                onClick={() => {
                  audioManager.playButtonHum();
                  setSettingsView('audio');
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 14px',
                  background: 'rgba(255, 255, 255, 0.06)',
                  border: '1px solid rgba(255, 255, 255, 0.14)',
                  borderRadius: 14,
                  cursor: 'pointer',
                  color: '#f3f4f6',
                  textAlign: 'left',
                  transition: 'all 0.15s ease',
                  fontFamily: 'inherit'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.85 }}>
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </svg>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>Sound Settings</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'inherit' }}>Volume, ambience & tactile noises</div>
                  </div>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            </div>
          ) : (
            /* Level 2: Audio Toggles & Sliders */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Background Music / Ambience */}
              <div style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                borderRadius: 14,
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                fontFamily: 'inherit'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#f3f4f6', fontFamily: 'inherit' }}>Ambient Music</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'inherit' }}>{isLight ? 'Soft Breeze & Birds' : 'Calm Piano & Ambient Pages'}</div>
                  </div>
                  <button
                    onClick={() => {
                      audioManager.playButtonHum();
                      const next = !bgMusicEnabled;
                      setBgMusicEnabled(next);
                      audioManager.setBgEnabled(next);
                    }}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 999,
                      border: '1px solid',
                      borderColor: bgMusicEnabled ? 'rgba(74, 222, 128, 0.45)' : 'rgba(255, 255, 255, 0.2)',
                      background: bgMusicEnabled ? 'rgba(34, 197, 94, 0.25)' : 'rgba(255, 255, 255, 0.08)',
                      color: bgMusicEnabled ? '#86efac' : '#9ca3af',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit'
                    }}
                  >
                    {bgMusicEnabled ? 'ON' : 'OFF'}
                  </button>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: bgMusicEnabled ? 1 : 0.45 }}>
                  <span style={{ fontSize: 11, color: '#9ca3af', minWidth: 24, fontFamily: 'inherit' }}>Vol</span>
                  <input 
                    type="range"
                    className="browse-slider"
                    min="0"
                    max="1"
                    step="0.005"
                    disabled={!bgMusicEnabled}
                    value={bgMusicVolume}
                    onPointerDown={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                    onTouchMove={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      setBgMusicVolume(val);
                      audioManager.setBgVolume(val);
                    }}
                    onInput={(e: any) => {
                      const val = parseFloat(e.target.value);
                      setBgMusicVolume(val);
                      audioManager.setBgVolume(val);
                    }}
                    style={{ flex: 1, touchAction: 'pan-x', cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: 11, color: '#d1d5db', minWidth: 28, textAlign: 'right', fontFamily: 'inherit' }}>
                    {Math.round(bgMusicVolume * 100)}%
                  </span>
                </div>
              </div>

              {/* Interactive Sound Effects */}
              <div style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                borderRadius: 14,
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                fontFamily: 'inherit'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#f3f4f6', fontFamily: 'inherit' }}>Interactive Noises</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'inherit' }}>Soft whooshes, thumps & clicks</div>
                  </div>
                  <button
                    onClick={() => {
                      audioManager.playButtonHum();
                      const next = !sfxEnabled;
                      setSfxEnabled(next);
                      audioManager.setSfxEnabled(next);
                    }}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 999,
                      border: '1px solid',
                      borderColor: sfxEnabled ? 'rgba(74, 222, 128, 0.45)' : 'rgba(255, 255, 255, 0.2)',
                      background: sfxEnabled ? 'rgba(34, 197, 94, 0.25)' : 'rgba(255, 255, 255, 0.08)',
                      color: sfxEnabled ? '#86efac' : '#9ca3af',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit'
                    }}
                  >
                    {sfxEnabled ? 'ON' : 'OFF'}
                  </button>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: sfxEnabled ? 1 : 0.45 }}>
                  <span style={{ fontSize: 11, color: '#9ca3af', minWidth: 24, fontFamily: 'inherit' }}>Vol</span>
                  <input 
                    type="range"
                    className="browse-slider"
                    min="0"
                    max="1"
                    step="0.005"
                    disabled={!sfxEnabled}
                    value={sfxVolume}
                    onPointerDown={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                    onTouchMove={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      setSfxVolume(val);
                      audioManager.setSfxVolume(val);
                    }}
                    onInput={(e: any) => {
                      const val = parseFloat(e.target.value);
                      setSfxVolume(val);
                      audioManager.setSfxVolume(val);
                    }}
                    style={{ flex: 1, touchAction: 'pan-x', cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: 11, color: '#d1d5db', minWidth: 28, textAlign: 'right', fontFamily: 'inherit' }}>
                    {Math.round(sfxVolume * 100)}%
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Bottom Right Settings Gear Button */}
      {!isHoldingPlacingBook && !isSelected && (
        <button
          onClick={() => {
            audioManager.playButtonHum();
            if (!isSettingsOpen) {
              setSettingsView('menu');
            }
            setIsSettingsOpen(!isSettingsOpen);
          }}
          title="Settings"
          style={{
            position: 'absolute',
            bottom: isMobile ? 'calc(env(safe-area-inset-bottom, 16px) + 16px)' : 34,
            right: isMobile ? 16 : 32,
            width: 52,
            height: 52,
            borderRadius: '50%',
            background: isSettingsOpen ? 'rgba(54, 48, 42, 0.95)' : uiPillBg,
            backdropFilter: 'blur(30px) saturate(220%)',
            border: isSettingsOpen ? '1.5px solid rgba(255, 255, 255, 0.85)' : uiPillBorder,
            boxShadow: isSettingsOpen
              ? '0 0 20px rgba(255, 255, 255, 0.45), inset 0 1px 1px rgba(255, 255, 255, 0.8)'
              : uiPillShadow,
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            zIndex: 45,
            transition: 'all 0.3s ease',
            transform: isSettingsOpen ? 'scale(1.05)' : 'scale(1.0)'
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      )}

      {/* Lower Dock */}
      {!isHoldingPlacingBook && !isSelected && (
        <div style={{
          position: 'absolute',
          bottom: isMobile ? 'calc(env(safe-area-inset-bottom, 16px) + 16px)' : 34,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 14,
          zIndex: 45
        }}>
          {isBrowseMode && sortedBooks.length > 0 && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              maxWidth: '92vw'
            }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 14px',
                background: uiPillBg,
                backdropFilter: 'blur(30px) saturate(220%)',
                border: uiPillBorder,
                borderRadius: 999,
                boxShadow: uiPillShadow,
                width: isMobile ? Math.min(windowWidth - 110, 250) : 290,
                boxSizing: 'border-box',
                transition: 'all 0.3s ease'
              }}>
                <button
                  onClick={() => {
                    audioManager.playButtonHum();
                    setBrowseFloat(prev => Math.max(0, Math.round(prev) - 1));
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#f3f4f6',
                    cursor: 'pointer',
                    fontSize: 20,
                    lineHeight: 1,
                    padding: '2px 4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: activeBrowseIndex > 0 ? 0.95 : 0.3,
                    transition: 'opacity 0.15s'
                  }}
                  title="Previous Book"
                >
                  ‹
                </button>

                <input
                  type="range"
                  className="browse-slider"
                  min={0}
                  max={Math.max(0, sortedBooks.length - 1)}
                  step={0.01}
                  value={browseFloat}
                  onChange={(e) => setBrowseFloat(parseFloat(e.target.value))}
                  style={{ flex: 1 }}
                />

                <button
                  onClick={() => {
                    audioManager.playButtonHum();
                    setBrowseFloat(prev => Math.min(sortedBooks.length - 1, Math.round(prev) + 1));
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#f3f4f6',
                    cursor: 'pointer',
                    fontSize: 20,
                    lineHeight: 1,
                    padding: '2px 4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: activeBrowseIndex < sortedBooks.length - 1 ? 0.95 : 0.3,
                    transition: 'opacity 0.15s'
                  }}
                  title="Next Book"
                >
                  ›
                </button>
              </div>

              <div style={{
                width: 38,
                height: 38,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: uiPillBg,
                backdropFilter: 'blur(30px) saturate(220%)',
                border: uiPillBorder,
                boxShadow: uiPillShadow,
                color: '#f3f4f6',
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '-0.02em',
                flexShrink: 0,
                transition: 'all 0.3s ease'
              }}>
                {sortedBooks.length === 0 ? '0' : `${activeBrowseIndex + 1}/${sortedBooks.length}`}
              </div>
            </div>
          )}

          <button
            onClick={() => {
              audioManager.playButtonHum();
              setIsBrowseMode(!isBrowseMode);
              if (isDropdownOpen) setIsDropdownOpen(false);
            }}
            title={isBrowseMode ? 'Exit Perspective Browse Mode' : 'Enter Perspective Browse Mode'}
            style={{
              width: 52,
              height: 52,
              borderRadius: '50%',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              background: isBrowseMode ? 'rgba(54, 48, 42, 0.95)' : uiPillBg,
              backdropFilter: 'blur(30px) saturate(220%)',
              border: isBrowseMode ? '1.5px solid rgba(255, 255, 255, 0.85)' : uiPillBorder,
              boxShadow: isBrowseMode 
                ? '0 0 20px rgba(255, 255, 255, 0.45), inset 0 2px 6px rgba(0, 0, 0, 0.4)' 
                : uiPillShadow,
              transform: isBrowseMode ? 'scale(0.95)' : 'scale(1.0)',
              cursor: 'pointer',
              transition: 'all 0.22s cubic-bezier(0.34, 1.56, 0.64, 1)'
            }}
          >
            <div style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              border: isBrowseMode ? '2px solid #ffffff' : '1.5px solid rgba(255, 255, 255, 0.5)',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              transition: 'all 0.2s ease'
            }}>
              <div style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: isBrowseMode ? '#ffffff' : 'rgba(255, 255, 255, 0.65)',
                boxShadow: isBrowseMode ? '0 0 8px #ffffff' : 'none',
                transition: 'all 0.2s ease'
              }} />
            </div>
          </button>
        </div>
      )}

      {/* 3D Scene */}
      <Canvas 
        dpr={[1, Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2)]}
        camera={{ position: [0, 0.0, 12.6], fov: 45 }}
        shadows
        gl={{ 
          powerPreference: 'high-performance',
          antialias: true,
          toneMapping: THREE.ACESFilmicToneMapping, 
          toneMappingExposure: 1.35
        }}
        onPointerLeave={() => {
          setHoveredBookId(null);
          document.body.style.cursor = 'default';
        }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget && selectedId !== null) {
            audioManager.playThump();
            setSelectedId(null);
            setIsFlipped(false);
            setShowMobileDetails(false);
          }
          if (isDropdownOpen) setIsDropdownOpen(false);
          if (isSettingsOpen) setIsSettingsOpen(false);
        }}
      >
        <SceneThemeController theme={theme} themeProgress={themeProgress} />
        
        <CameraController 
          isSelected={isSelected} 
          showMobileDetails={showMobileDetails}
          isPickingPosition={isHoldingPlacingBook}
          isBrowseMode={isBrowseMode}
          isIdle={isIdle}
          books={books}
          bookShelfPositions={bookShelfPositions}
          totalShelves={totalShelves}
          browsedTargetPos={browsedTargetPos}
          isUserInteracting={isUserInteracting}
          isMobile={isMobile}
          controlsRef={controlsRef} 
        />
        <NeutralLibraryLightingRig 
          totalShelves={totalShelves} 
          isSelected={isSelected} 
          showMobileDetails={showMobileDetails}
          isMobile={isMobile} 
          themeProgress={themeProgress}
        />

        <DarkFocusCurtain active={isSelected} themeProgress={themeProgress} />
        <ArchitecturalBookcase shelfCount={totalShelves} themeProgress={themeProgress} />

        {/* Glided Interactive Plane for Mouse Hover & Touch Drag */}
        {isHoldingPlacingBook && placementMode === 'glide' && editingBook && (
          <GlidedPlacementPlane
            totalShelves={totalShelves}
            books={books}
            editingBook={editingBook}
            isMobile={isMobile}
            hoveredPlacement={hoveredPlacement}
            onHoverSlot={(slot) => setHoveredPlacement(slot)}
            onConfirmPlacement={handleConfirmPlacement}
            onStartDrag={() => setIsDraggingShelf(true)}
            onEndDrag={() => setIsDraggingShelf(false)}
          />
        )}

        {/* Dynamic Ghost Book Preview */}
        {isHoldingPlacingBook && (
          <GhostBookPreview
            totalShelves={totalShelves}
            books={books}
            editingBook={editingBook}
            hoveredPlacement={hoveredPlacement}
          />
        )}

        {books.map((book) => {
          const pos = bookShelfPositions.get(book.id!) || { x: 0, row: 0 };
          return (
            <BookMesh
              key={book.id}
              book={book}
              shelfX={pos.x}
              shelfRow={pos.row}
              totalShelves={totalShelves}
              isSelected={selectedId === book.id}
              isFlipped={selectedId === book.id && isFlipped}
              isDeleting={deletingId === book.id}
              isHighlighted={highlightedBookId === book.id}
              isPlacing={editingBook?.id === book.id}
              isHovered={effectiveHoveredId === book.id}
              isEditingOrAdding={isEditingOrAdding}
              isBrowseMode={isBrowseMode}
              isMobile={isMobile}
              showMobileDetails={showMobileDetails}
              hasSelection={selectedId !== null}
              placementMode={placementMode}
              ghostNormPos={ghostNormPos}
              pointerPos={pointerPos}
              onHover={() => {
                if (!isBrowseMode && !isHoldingPlacingBook) {
                  setHoveredBookId(book.id!);
                  document.body.style.cursor = 'pointer';
                }
              }}
              onUnhover={() => {
                if (!isBrowseMode && !isHoldingPlacingBook) {
                  setHoveredBookId((curr) => (curr === book.id ? null : curr));
                  document.body.style.cursor = 'default';
                }
              }}
              onSelect={() => {
                if (selectedId === book.id) {
                  // Keep open
                } else {
                  audioManager.playDeepSoftWhoosh();
                  setSelectedId(book.id!);
                  setIsFlipped(false);
                  setShowMobileDetails(false);
                  requestGyroPermission();
                }
              }}
            />
          );
        })}

        <OrbitControls 
          ref={controlsRef}
          enabled={!selectedId && !deletingId && !isHoldingPlacingBook && !isIdle} 
          maxPolarAngle={Math.PI / 2 + 0.05} 
          minDistance={3.5} 
          maxDistance={22}
          onStart={() => {
            isUserInteracting.current = true;
          }}
          onEnd={() => {
            isUserInteracting.current = false;
          }}
        />
      </Canvas>

      {/* 3 Mobile Glossy Round Buttons */}
      {isMobile && activeBook && !deletingId && !isEditingOrAdding && (
        <div style={{
          position: 'absolute',
          bottom: 'calc(env(safe-area-inset-bottom, 16px) + 16px)',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 22,
          zIndex: 80
        }}>
          <button
            onClick={() => {
              audioManager.playDeepSoftWhoosh();
              setIsFlipped(!isFlipped);
            }}
            title="Flip Book"
            style={{
              width: 54,
              height: 54,
              borderRadius: '50%',
              background: uiPillBg,
              backdropFilter: 'blur(35px) saturate(240%)',
              border: uiPillBorder,
              boxShadow: uiPillShadow,
              color: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.3s ease'
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.636-6.364M21 3v6h-6" />
            </svg>
          </button>

          <button
            onClick={() => {
              audioManager.playButtonHum();
              setShowMobileDetails(!showMobileDetails);
            }}
            title="Book Info"
            style={{
              width: 54,
              height: 54,
              borderRadius: '50%',
              background: showMobileDetails ? 'rgba(54, 48, 42, 0.95)' : uiPillBg,
              backdropFilter: 'blur(35px) saturate(240%)',
              border: showMobileDetails ? '1.5px solid rgba(255, 255, 255, 0.85)' : uiPillBorder,
              boxShadow: showMobileDetails 
                ? '0 0 20px rgba(255, 255, 255, 0.4), inset 0 1px 1px rgba(255, 255, 255, 0.8)' 
                : uiPillShadow,
              color: '#ffffff',
              fontSize: 22,
              fontFamily: 'Georgia, serif',
              fontStyle: 'italic',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.3s ease'
            }}
          >
            i
          </button>

          <button
            onClick={() => {
              audioManager.playThump();
              setSelectedId(null);
              setIsFlipped(false);
              setShowMobileDetails(false);
            }}
            title="Return to Shelf"
            style={{
              width: 54,
              height: 54,
              borderRadius: '50%',
              background: isLight ? 'rgba(70, 24, 24, 0.88)' : 'rgba(239, 68, 68, 0.18)',
              backdropFilter: 'blur(35px) saturate(240%)',
              border: isLight ? '1px solid rgba(248, 113, 113, 0.55)' : '1px solid rgba(248, 113, 113, 0.45)',
              boxShadow: uiPillShadow,
              color: '#fca5a5',
              fontSize: 20,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.3s ease'
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Glossy Transparent Details Sheet */}
      {activeBook && !deletingId && !isEditingOrAdding && (!isMobile || showMobileDetails) && (
        <div 
          style={{
            position: 'absolute',
            left: isMobile ? 12 : 'auto',
            right: isMobile ? 12 : 48,
            top: isMobile ? 'auto' : '50%',
            bottom: isMobile ? 'calc(env(safe-area-inset-bottom, 16px) + 84px)' : 'auto',
            transform: isMobile ? 'none' : 'translateY(-50%)',
            width: isMobile ? 'calc(100vw - 24px)' : 370,
            maxHeight: isMobile ? '38vh' : '84vh',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            background: isLight ? 'rgba(24, 21, 19, 0.94)' : 'rgba(10, 14, 22, 0.40)',
            backdropFilter: 'blur(45px) saturate(240%)',
            border: uiPillBorder,
            borderRadius: 24,
            padding: isMobile ? '16px 18px' : 30,
            color: '#f3f4f6',
            fontFamily: 'system-ui, sans-serif',
            boxShadow: '0 32px 64px rgba(0, 0, 0, 0.85), inset 0 1px 0 rgba(255, 255, 255, 0.25)',
            zIndex: 70,
            transition: 'background 0.3s ease'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
            <h2 style={{ margin: 0, fontSize: isMobile ? 18 : 23, fontWeight: 700, color: '#fcf8f0', fontFamily: 'Georgia, serif', letterSpacing: '-0.01em', flex: 1, paddingRight: 8 }}>
              {activeBook.title}
            </h2>
            {isMobile && (
              <button
                onClick={() => {
                  audioManager.playButtonHum();
                  setShowMobileDetails(false);
                }}
                style={{
                  background: 'rgba(255, 255, 255, 0.12)',
                  border: 'none',
                  color: '#ffffff',
                  borderRadius: '50%',
                  width: 26,
                  height: 26,
                  cursor: 'pointer',
                  fontSize: 14,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                ✕
              </button>
            )}
          </div>
          
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <p style={{ margin: 0, color: '#9ca3af', fontSize: 12, fontStyle: 'italic' }}>{activeBook.author}</p>
            {activeBook.format && (
              <span style={{ 
                fontSize: 10, 
                color: '#d1d5db', 
                textTransform: 'uppercase', 
                letterSpacing: '0.06em',
                background: 'rgba(255, 255, 255, 0.08)', 
                padding: '2px 7px', 
                borderRadius: 6,
                border: '1px solid rgba(255, 255, 255, 0.12)' 
              }}>
                {activeBook.format}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {activeBook.pageCount ? (
              <span style={{ 
                fontSize: 11, 
                background: 'rgba(255, 255, 255, 0.08)', 
                padding: '2px 7px', 
                borderRadius: 8, 
                color: '#e5e7eb', 
                border: '1px solid rgba(255, 255, 255, 0.16)',
                fontWeight: 500,
                backdropFilter: 'blur(10px)'
              }}>
                {activeBook.pageCount} pages
              </span>
            ) : null}
            {activeBook.isbn ? (
              <span style={{ 
                fontSize: 11, 
                background: 'rgba(255, 255, 255, 0.08)', 
                padding: '2px 7px', 
                borderRadius: 8, 
                color: '#cbd5e1', 
                border: '1px solid rgba(255, 255, 255, 0.16)',
                fontFamily: 'monospace',
                letterSpacing: '0.02em',
                backdropFilter: 'blur(10px)'
              }}>
                ISBN {activeBook.isbn}
              </span>
            ) : null}
          </div>

          <div style={{ color: '#ffffff', fontSize: 14, marginBottom: 10, letterSpacing: '2px' }}>
            {'★'.repeat(activeBook.rating)}{'☆'.repeat(5 - activeBook.rating)}
          </div>
          
          <div className="seamless-glass-scroll" style={{ overflowY: 'auto', flex: 1, paddingRight: 6, marginBottom: 12 }}>
            <p style={{ margin: 0, color: '#d1d5db', lineHeight: 1.55, fontSize: 13 }}>
              {activeBook.review}
            </p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {!isMobile && (
              <button
                onClick={() => {
                  audioManager.playDeepSoftWhoosh();
                  setIsFlipped(!isFlipped);
                }}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: '#ffffff',
                  border: '1px solid rgba(255, 255, 255, 0.18)',
                  borderRadius: 12,
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  backdropFilter: 'blur(12px)',
                  boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.2)',
                  transition: 'background 0.2s'
                }}
              >
                {isFlipped ? 'Flip to Front Cover' : 'Flip to Back Cover'}
              </button>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => {
                  audioManager.playButtonHum();
                  const bToEdit = activeBook;
                  setSelectedId(null);
                  setIsFlipped(false);
                  setShowMobileDetails(false);
                  setEditingBook(bToEdit);
                }}
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  background: 'rgba(255, 255, 255, 0.08)',
                  color: '#f3f4f6',
                  border: '1px solid rgba(255, 255, 255, 0.16)',
                  borderRadius: 12,
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 500,
                  backdropFilter: 'blur(12px)',
                  boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.15)',
                  transition: 'background 0.2s'
                }}
              >
                Change Position
              </button>
              <button
                onClick={() => handleDeleteBook(activeBook.id)}
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  background: 'rgba(220, 38, 38, 0.16)',
                  color: '#fca5a5',
                  border: '1px solid rgba(220, 38, 38, 0.35)',
                  borderRadius: 12,
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 500,
                  backdropFilter: 'blur(12px)',
                  transition: 'background 0.2s'
                }}
              >
                Remove Book
              </button>
            </div>

            {!isMobile && (
              <button
                onClick={() => {
                  audioManager.playThump();
                  setSelectedId(null);
                  setIsFlipped(false);
                }}
                style={{
                  width: '100%',
                  padding: '11px 16px',
                  background: 'rgba(255, 255, 255, 0.22)',
                  color: '#ffffff',
                  border: '1px solid rgba(255, 255, 255, 0.35)',
                  borderRadius: 12,
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: 13,
                  backdropFilter: 'blur(12px)',
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.35)',
                  transition: 'background 0.2s'
                }}
              >
                Return to Shelf
              </button>
            )}
          </div>
        </div>
      )}

      {/* Add Book Modal */}
      {isModalOpen && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.65)',
          backdropFilter: 'blur(16px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000,
          padding: isMobile ? '12px' : '20px',
          boxSizing: 'border-box'
        }}>
          <div style={{
            background: isLight ? 'rgba(24, 21, 19, 0.96)' : 'rgba(15, 20, 28, 0.88)',
            backdropFilter: 'blur(40px) saturate(220%)',
            border: uiPillBorder,
            borderRadius: 24,
            padding: isMobile ? '18px 16px' : '24px 28px',
            width: isMobile ? '100%' : '440px',
            maxHeight: '85vh',
            overflowY: 'auto',
            color: '#f3f4f6',
            boxShadow: '0 28px 60px rgba(0, 0, 0, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.25)',
            display: 'flex',
            flexDirection: 'column',
            boxSizing: 'border-box'
          }}>
            <h3 style={{ margin: '0 0 4px', fontSize: isMobile ? 18 : 21, fontWeight: 700, fontFamily: 'Georgia, serif', color: '#fcf8f0', textAlign: 'center' }}>
              Add Book to Shelf
            </h3>
            
            <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 12px', lineHeight: 1.4, textAlign: 'center' }}>
              Scan or enter your ISBN to look up specifications.
            </p>

            {isScanningCamera ? (
              <div style={{ width: '100%', height: 140, background: '#000', borderRadius: 12, overflow: 'hidden', marginBottom: 12, position: 'relative', border: '1px solid rgba(255,255,255,0.15)', flexShrink: 0 }}>
                {cameraError ? (
                  <div style={{ padding: '16px', color: '#fca5a5', fontSize: 12, lineHeight: 1.4, textAlign: 'center' }}>
                    {cameraError}
                  </div>
                ) : (
                  <video 
                    ref={videoRef} 
                    autoPlay 
                    playsInline 
                    muted 
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }} 
                  />
                )}
                <button
                  onClick={() => {
                    audioManager.playButtonHum();
                    stopCameraStream();
                  }}
                  style={{
                    position: 'absolute',
                    top: 8,
                    right: 8,
                    background: 'rgba(0,0,0,0.75)',
                    color: 'white',
                    border: 'none',
                    borderRadius: 6,
                    padding: '3px 7px',
                    fontSize: 11,
                    cursor: 'pointer'
                  }}
                >
                  Close
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  audioManager.playButtonHum();
                  setIsScanningCamera(true);
                }}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  marginBottom: 12,
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: '#f3f4f6',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: 12,
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: 13,
                  backdropFilter: 'blur(12px)',
                  flexShrink: 0
                }}
              >
                Scan Barcode
              </button>
            )}

            <div style={{ width: '100%', marginBottom: 12, textAlign: 'left', flexShrink: 0 }}>
              <label style={{ fontSize: 11, color: '#9ca3af', fontWeight: 500, paddingLeft: 2 }}>ISBN:</label>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <input 
                  type="text" 
                  placeholder="e.g. 9781447274643"
                  value={manualIsbn}
                  onChange={(e) => {
                    setManualIsbn(e.target.value);
                    setResolvedBook(null);
                  }}
                  style={{ 
                    flex: 1, 
                    padding: '8px 12px', 
                    background: 'rgba(255, 255, 255, 0.07)', 
                    border: '1px solid rgba(255, 255, 255, 0.2)', 
                    borderRadius: 10, 
                    color: '#fafafa', 
                    fontSize: '16px',
                    outline: 'none',
                    boxSizing: 'border-box'
                  }}
                />
                <button
                  type="button"
                  disabled={isSearchingIsbn || !manualIsbn.trim()}
                  onClick={handleLookupIsbn}
                  style={{
                    padding: '8px 14px',
                    background: 'rgba(255, 255, 255, 0.18)',
                    color: '#ffffff',
                    border: '1px solid rgba(255, 255, 255, 0.3)',
                    borderRadius: 10,
                    cursor: isSearchingIsbn || !manualIsbn.trim() ? 'not-allowed' : 'pointer',
                    fontWeight: 600,
                    fontSize: 12,
                    whiteSpace: 'nowrap'
                  }}
                >
                  {isSearchingIsbn ? 'Looking up...' : 'Look Up'}
                </button>
              </div>
            </div>

            {resolvedBook && (
              <div style={{
                width: '100%',
                background: 'rgba(0, 0, 0, 0.25)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: 14,
                padding: 12,
                marginBottom: 12,
                textAlign: 'left',
                boxSizing: 'border-box',
                flexShrink: 0
              }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                  <img 
                    src={resolvedBook.coverUrl} 
                    alt="Cover" 
                    style={{ width: 38, height: 56, objectFit: 'cover', borderRadius: 4, background: '#1e293b' }} 
                  />
                  <div style={{ overflow: 'hidden', flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#fcf8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {resolvedBook.title}
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {resolvedBook.author}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 10, color: '#9ca3af', fontWeight: 500 }}>Page Count:</label>
                    {resolvedBook.pageCount ? (
                      <div style={{ 
                        fontSize: 12, 
                        color: '#34d399', 
                        fontWeight: 600, 
                        background: 'rgba(52, 211, 153, 0.12)', 
                        padding: '5px 8px', 
                        borderRadius: 6, 
                        marginTop: 2,
                        border: '1px solid rgba(52, 211, 153, 0.25)' 
                      }}>
                        {resolvedBook.pageCount} pages
                      </div>
                    ) : (
                      <input
                        type="number"
                        placeholder="Page count"
                        value={fallbackPages}
                        onChange={(e) => setFallbackPages(e.target.value)}
                        style={{
                          width: '100%',
                          padding: '6px 10px',
                          background: 'rgba(239, 68, 68, 0.1)',
                          border: '1px solid rgba(239, 68, 68, 0.4)',
                          borderRadius: 6,
                          color: '#ffffff',
                          marginTop: 2,
                          fontSize: '16px',
                          outline: 'none',
                          boxSizing: 'border-box'
                        }}
                      />
                    )}
                  </div>

                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 10, color: '#9ca3af', fontWeight: 500 }}>Format:</label>
                    {resolvedBook.format ? (
                      <div style={{ 
                        fontSize: 12, 
                        color: '#34d399', 
                        fontWeight: 600, 
                        background: 'rgba(52, 211, 153, 0.12)', 
                        padding: '5px 8px', 
                        borderRadius: 6, 
                        marginTop: 2,
                        border: '1px solid rgba(52, 211, 153, 0.25)' 
                      }}>
                        {resolvedBook.format}
                      </div>
                    ) : (
                      <select
                        value={fallbackFormat}
                        onChange={(e) => setFallbackFormat(e.target.value)}
                        style={{
                          width: '100%',
                          padding: '6px 8px',
                          background: '#1c2430',
                          border: '1px solid rgba(255, 255, 255, 0.25)',
                          borderRadius: 6,
                          color: '#ffffff',
                          marginTop: 2,
                          fontSize: '16px',
                          outline: 'none',
                          boxSizing: 'border-box'
                        }}
                      >
                        <option value="Paperback">Paperback</option>
                        <option value="Hardcover">Hardcover</option>
                      </select>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div style={{ width: '100%', marginBottom: 10, textAlign: 'left', flexShrink: 0 }}>
              <label style={{ fontSize: 11, color: '#9ca3af', fontWeight: 500, paddingLeft: 2 }}>Rating:</label>
              <div style={{ display: 'flex', gap: 6, marginTop: 2, fontSize: 22, cursor: 'pointer', paddingLeft: 2 }}>
                {[1, 2, 3, 4, 5].map((star) => {
                  const activeStars = hoverRating !== null ? hoverRating : rating;
                  return (
                    <span
                      key={star}
                      onMouseEnter={() => setHoverRating(star)}
                      onMouseLeave={() => setHoverRating(null)}
                      onClick={() => {
                        audioManager.playButtonHum();
                        setRating(star);
                      }}
                      style={{ 
                        color: star <= activeStars ? '#ffffff' : '#4b5563', 
                        transition: 'transform 0.15s ease, color 0.15s ease', 
                        transform: star <= activeStars ? 'scale(1.08)' : 'scale(1)', 
                        display: 'inline-block'
                      }}
                    >
                      ★
                    </span>
                  );
                })}
              </div>
            </div>

            <div style={{ width: '100%', marginBottom: 14, textAlign: 'left', flexShrink: 0 }}>
              <label style={{ fontSize: 11, color: '#9ca3af', fontWeight: 500, paddingLeft: 2 }}>Personal Notes (optional):</label>
              <textarea 
                rows={2}
                placeholder="Leave blank to use official blurb."
                value={personalNotes}
                onChange={(e) => setPersonalNotes(e.target.value)}
                style={{ 
                  width: '100%', 
                  padding: '8px 12px', 
                  background: 'rgba(255, 255, 255, 0.07)', 
                  border: '1px solid rgba(255, 255, 255, 0.2)', 
                  borderRadius: 10, 
                  color: '#fafafa', 
                  marginTop: 2, 
                  backdropFilter: 'blur(12px)', 
                  outline: 'none', 
                  boxSizing: 'border-box', 
                  resize: 'none',
                  fontSize: '16px'
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: 10, width: '100%', flexShrink: 0 }}>
              <button
                disabled={!resolvedBook || (!resolvedBook.pageCount && !fallbackPages)}
                onClick={handleConfirmSave}
                style={{ 
                  flex: 1, 
                  padding: '10px 14px', 
                  background: resolvedBook && (resolvedBook.pageCount || fallbackPages) ? 'rgba(255, 255, 255, 0.25)' : 'rgba(255, 255, 255, 0.08)', 
                  color: '#ffffff', 
                  border: '1px solid rgba(255, 255, 255, 0.35)', 
                  borderRadius: 12, 
                  cursor: resolvedBook && (resolvedBook.pageCount || fallbackPages) ? 'pointer' : 'not-allowed', 
                  fontWeight: 700, 
                  fontSize: 13, 
                  backdropFilter: 'blur(12px)', 
                  boxShadow: '0 8px 24px rgba(0,0,0,0.4)'
                }}
              >
                Save Book
              </button>
              <button
                onClick={() => {
                  audioManager.playButtonHum();
                  stopCameraStream();
                  setIsModalOpen(false);
                  setResolvedBook(null);
                }}
                style={{ 
                  padding: '10px 16px', 
                  background: 'rgba(255, 255, 255, 0.08)', 
                  color: '#d1d5db', 
                  border: '1px solid rgba(255, 255, 255, 0.2)', 
                  borderRadius: 12, 
                  cursor: 'pointer', 
                  fontWeight: 600, 
                  fontSize: 13, 
                  backdropFilter: 'blur(12px)'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}