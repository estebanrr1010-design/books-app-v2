import { useRef, useMemo, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type SavedBook } from './db';

const SHELF_HEIGHT_GAP = 3.3;
const SHELF_THICKNESS = 0.22;
const SHELF_DEPTH = 2.4;
const BOOK_GAP = 0.03;

// Exact shelf front edge
const SHELF_FRONT_LIP_Z = SHELF_DEPTH / 2; // 1.20
const WALK_LANE_Z = 0.98;

function getBookDimensions(book: SavedBook) {
  const isHardcover = (book.format || '').toLowerCase().includes('hard') || (book.format || '').toLowerCase().includes('bound');
  const overhangY = isHardcover ? 0.065 : 0;
  if (book.customHeight && book.customThickness && book.customDepth) {
    return { thickness: book.customThickness, height: book.customHeight + overhangY * 2 };
  }
  const pages = Math.max(book.pageCount || 300, 16);
  const thickness = book.customThickness ?? Math.min(Math.max((pages * 0.00058) + (isHardcover ? 0.08 : 0.032), 0.13), 0.95);
  let baseHeight = book.customHeight ?? 2.12;
  if (!book.customHeight) {
    if (pages > 850) baseHeight = 2.45;
    else if (pages > 550) baseHeight = 2.32;
    else if (pages < 200) baseHeight = 1.95;
    else if (pages < 350) baseHeight = 2.08;
  }
  return { thickness, height: baseHeight + overhangY * 2 };
}

interface ShelfLittleGuyProps {
  isIdle?: boolean;
  targetShelfRow?: number;
  totalShelves?: number;
  idleTriggerDelay?: number;
}

export function ShelfLittleGuy({
  isIdle = true,
  targetShelfRow = 1,
  totalShelves = 3,
  idleTriggerDelay = 30
}: ShelfLittleGuyProps) {
  const books = useLiveQuery(() => db.books.toArray()) ?? [];

  const rootRef = useRef<THREE.Group>(null!);
  const pelvisRef = useRef<THREE.Group>(null!);
  const torsoRef = useRef<THREE.Group>(null!);
  const headRef = useRef<THREE.Group>(null!);
  const leftShoulderRef = useRef<THREE.Group>(null!);
  const rightShoulderRef = useRef<THREE.Group>(null!);
  const leftElbowRef = useRef<THREE.Group>(null!);
  const rightElbowRef = useRef<THREE.Group>(null!);
  const leftHipRef = useRef<THREE.Group>(null!);
  const rightHipRef = useRef<THREE.Group>(null!);
  const leftKneeRef = useRef<THREE.Group>(null!);
  const rightKneeRef = useRef<THREE.Group>(null!);

  const idleTimer = useRef(0);
  const sequenceActive = useRef(false);
  const sequenceTime = useRef(0);
  const [visible, setVisible] = useState(false);

  const shelfTopY = useMemo(() => {
    return (targetShelfRow - (totalShelves - 1) / 2) * SHELF_HEIGHT_GAP - 1.25 + SHELF_THICKNESS / 2;
  }, [targetShelfRow, totalShelves]);

  // Clean soft matte inflatable white material (Baymax style)
  const characterMaterial = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 0.28,
      metalness: 0.02,
      emissive: '#111111',
      transparent: true,
      opacity: 0,
      depthWrite: true,
    });
  }, []);

  // Seamless, single-body rounded shapes without exposed ball joints
  const geoms = useMemo(() => {
    return {
      head: new THREE.SphereGeometry(0.068, 28, 28),
      torsoMain: new THREE.SphereGeometry(0.078, 28, 24),
      bellyCap: new THREE.SphereGeometry(0.072, 24, 20),
      // Single continuous overlapping capsules for limbs
      armSegment: new THREE.CylinderGeometry(0.022, 0.02, 0.08, 20),
      armCap: new THREE.SphereGeometry(0.021, 20, 16),
      legSegment: new THREE.CylinderGeometry(0.027, 0.024, 0.08, 20),
      footCap: new THREE.SphereGeometry(0.024, 20, 16),
    };
  }, []);

  const rightmostBookEdgeX = useMemo(() => {
    const rowBooks = books
      .filter((b) => (b.shelfRow ?? 0) === targetShelfRow)
      .sort((a, b) => (a.shelfIndex ?? 0) - (b.shelfIndex ?? 0));

    if (rowBooks.length === 0) return 1.5;

    const thicknesses = rowBooks.map((b) => getBookDimensions(b).thickness);
    const totalW = thicknesses.reduce((sum, t) => sum + t, 0) + Math.max(0, rowBooks.length - 1) * BOOK_GAP;
    return totalW / 2;
  }, [books, targetShelfRow]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);

    if (isIdle) {
      idleTimer.current += dt;
      if (idleTimer.current >= idleTriggerDelay && !sequenceActive.current) {
        sequenceActive.current = true;
        sequenceTime.current = 0;
        setVisible(true);
      }
    } else {
      idleTimer.current = 0;
      if (sequenceActive.current) {
        characterMaterial.opacity = THREE.MathUtils.lerp(characterMaterial.opacity, 0, dt * 7.0);
        if (characterMaterial.opacity < 0.02) {
          sequenceActive.current = false;
          setVisible(false);
        }
        return;
      }
    }

    if (!sequenceActive.current || !rootRef.current) return;

    sequenceTime.current += dt;
    const t = sequenceTime.current;

    // Grounded floor kinematics
    // Thigh length (0.07) + calf length (0.07) + foot radius (0.024) = 0.164 total leg drop
    const legDropHeight = 0.164;
    const standingPelvisY = shelfTopY + legDropHeight;

    let posX = -5.4;
    let posY = standingPelvisY;
    let posZ = WALK_LANE_Z;
    let rotY = Math.PI / 2;

    let headPitch = 0;
    let headYaw = 0;
    let headRoll = 0;

    let torsoPitch = 0;
    let torsoRoll = 0;
    let squashY = 1.0;
    let squashXZ = 1.0;

    let lShoulderX = 0;
    let rShoulderX = 0;
    let lShoulderZ = 0.05;
    let rShoulderZ = -0.05;
    let lElbowX = 0;
    let rElbowX = 0;

    let lHipX = 0;
    let rHipX = 0;
    let lKneeX = 0;
    let rKneeX = 0;

    let targetOpacity = 1.0;

    // Fluid, organic walk with plant-foot shelf contact
    const applyWalkCycle = (speed: number, stride: number) => {
      const cycle = t * speed;
      const swing = Math.sin(cycle) * stride;

      lHipX = swing;
      rHipX = -swing;
      lKneeX = swing > 0 ? swing * 0.85 : 0.02;
      rKneeX = -swing > 0 ? -swing * 0.85 : 0.02;

      lShoulderX = -swing * 0.65;
      rShoulderX = swing * 0.65;
      lElbowX = -0.15;
      rElbowX = -0.15;

      // Keep stance foot planted flush on the shelf wood surface
      const lowestFootAngle = Math.max(Math.abs(lHipX), Math.abs(rHipX));
      const footDrop = (0.07 * Math.cos(lowestFootAngle)) + (0.07 * Math.cos(lowestFootAngle * 0.5)) + 0.024;
      posY = shelfTopY + footDrop;

      torsoRoll = Math.sin(cycle) * 0.04;
      torsoPitch = 0.05;
    };

    if (t < 9.0) {
      // 1. Entry
      const u = Math.min(t / 8.5, 1.0);
      posX = THREE.MathUtils.lerp(-5.4, -1.8, u);
      targetOpacity = Math.min(t * 1.8, 1.0);
      rotY = Math.PI / 2;
      applyWalkCycle(6.2, 0.62);
    } else if (t < 13.5) {
      // 2. Curiosity (Stops, looks up at books)
      const u = (t - 9.0) / 4.5;
      posX = -1.8;
      posY = standingPelvisY;
      rotY = THREE.MathUtils.lerp(Math.PI / 2, Math.PI * 0.82, Math.min(u * 2, 1.0));
      headPitch = THREE.MathUtils.lerp(0, -0.65, Math.min(u * 1.6, 1.0)) + Math.sin(t * 1.6) * 0.04;
      headYaw = Math.sin(t * 1.2) * 0.15;
      torsoPitch = -0.06;
    } else if (t < 19.0) {
      // 3. Pondering (Scratching head)
      posX = -1.8;
      posY = standingPelvisY;
      rotY = Math.PI * 0.82;
      headPitch = -0.55;
      headRoll = 0.16;

      const armUp = THREE.MathUtils.clamp((t - 13.5) / 1.2, 0, 1);
      const armDown = THREE.MathUtils.clamp((t - 17.6) / 1.4, 0, 1);
      const blend = armUp * (1 - armDown);

      const scratchWiggle = Math.sin(t * 11.0) * 0.16;
      rShoulderX = THREE.MathUtils.lerp(0, -2.35 + scratchWiggle, blend);
      rShoulderZ = THREE.MathUtils.lerp(-0.08, 0.42, blend);
      rElbowX = THREE.MathUtils.lerp(0, -2.15 + scratchWiggle * 1.1, blend);
    } else if (t < 25.0) {
      // 4. Resting (Walks right to the exact edge, bends knees, and PLOPS down)
      const u = (t - 19.0) / 6.0;
      if (u < 0.45) {
        // Steps all the way to the shelf edge lip
        const walkU = u / 0.45;
        posZ = THREE.MathUtils.lerp(WALK_LANE_Z, SHELF_FRONT_LIP_Z - 0.01, walkU);
        posX = -1.8;
        rotY = 0;
        applyWalkCycle(5.8, 0.5);
      } else {
        // Plop transition: Sinks down and lands with impact squash
        const sitU = THREE.MathUtils.clamp((u - 0.45) / 0.55, 0, 1);
        posZ = SHELF_FRONT_LIP_Z - 0.01; // Sits right on the front perimeter
        posX = -1.8;
        rotY = 0;

        // Gravity plop curve: accelerates downward, hits bottom, small bounce
        const plopFall = Math.pow(sitU, 2.2);
        // Butt rests directly on shelf top surface
        const buttSeatedY = shelfTopY + 0.024;
        posY = THREE.MathUtils.lerp(standingPelvisY, buttSeatedY, plopFall);

        // Impact squash when bottom lands
        if (sitU > 0.85) {
          const impact = Math.sin((sitU - 0.85) / 0.15 * Math.PI);
          squashY = 1.0 - (impact * 0.18);
          squashXZ = 1.0 + (impact * 0.14);
        }

        // Hips fold 90 deg forward, knees fold 90 deg down over edge
        lHipX = THREE.MathUtils.lerp(0, -Math.PI / 2, plopFall);
        rHipX = THREE.MathUtils.lerp(0, -Math.PI / 2, plopFall);
        lKneeX = THREE.MathUtils.lerp(0, Math.PI / 2, plopFall);
        rKneeX = THREE.MathUtils.lerp(0, Math.PI / 2, plopFall);

        // Hands brace on the shelf edge beside body
        lShoulderX = THREE.MathUtils.lerp(0, 0.28, plopFall);
        rShoulderX = THREE.MathUtils.lerp(0, 0.28, plopFall);
        lElbowX = THREE.MathUtils.lerp(0, -0.45, plopFall);
        rElbowX = THREE.MathUtils.lerp(0, -0.45, plopFall);
      }
    } else if (t < 33.0) {
      // 5. Dangle (Butt firmly grounded on edge, calves swinging freely)
      posX = -1.8;
      posY = shelfTopY + 0.024; // zero floating
      posZ = SHELF_FRONT_LIP_Z - 0.01;
      rotY = 0;

      lHipX = -Math.PI / 2;
      rHipX = -Math.PI / 2;

      const swingCycle = (t - 25.0) * 2.6;
      lKneeX = Math.PI / 2 + Math.sin(swingCycle) * 0.38;
      rKneeX = Math.PI / 2 + Math.sin(swingCycle - 0.7) * 0.38;

      headYaw = Math.sin(t * 1.1) * 0.24;
      headPitch = 0.08;
      torsoPitch = 0.04;

      lShoulderX = 0.25;
      rShoulderX = 0.25;
      lElbowX = -0.4;
      rElbowX = -0.4;
    } else if (t < 37.5) {
      // 6. Resuming (Effortful stand up: pushes off ledge with hands)
      const u = (t - 33.0) / 4.5;
      posX = -1.8;
      rotY = THREE.MathUtils.lerp(0, Math.PI / 2, THREE.MathUtils.clamp((u - 0.4) / 0.6, 0, 1));

      if (u < 0.4) {
        // Lean torso heavily forward over edge
        const pushU = u / 0.4;
        torsoPitch = THREE.MathUtils.lerp(0.04, 0.52, pushU);
        posY = shelfTopY + 0.024 + pushU * 0.05;
        lShoulderX = 0.45;
        rShoulderX = 0.45;
        lElbowX = -0.65;
        rElbowX = -0.65;
      } else {
        // Push legs straight up
        const riseU = (u - 0.4) / 0.6;
        const easeRise = 0.5 - 0.5 * Math.cos(riseU * Math.PI);
        posY = THREE.MathUtils.lerp(shelfTopY + 0.074, standingPelvisY, easeRise);
        posZ = THREE.MathUtils.lerp(SHELF_FRONT_LIP_Z - 0.01, WALK_LANE_Z, easeRise);
        torsoPitch = THREE.MathUtils.lerp(0.52, 0.0, easeRise);

        lHipX = THREE.MathUtils.lerp(-Math.PI / 2, 0, easeRise);
        rHipX = THREE.MathUtils.lerp(-Math.PI / 2, 0, easeRise);
        lKneeX = THREE.MathUtils.lerp(Math.PI / 2, 0, easeRise);
        rKneeX = THREE.MathUtils.lerp(Math.PI / 2, 0, easeRise);
      }
    } else if (t < 44.0) {
      // 7. Exploration (Walks to rightmost book)
      const strollU = (t - 37.5) / 6.5;
      const targetKickStopX = rightmostBookEdgeX + 0.16;
      posX = THREE.MathUtils.lerp(-1.8, targetKickStopX, strollU);
      posZ = WALK_LANE_Z;
      rotY = Math.PI / 2;
      applyWalkCycle(6.2, 0.62);
    } else if (t < 49.5) {
      // 8. Silly Interaction (Kicks the book cover directly)
      const kickT = t - 44.0;
      const targetKickStopX = rightmostBookEdgeX + 0.16;
      posZ = WALK_LANE_Z;

      if (kickT < 1.2) {
        posX = targetKickStopX;
        posY = standingPelvisY;
        rotY = THREE.MathUtils.lerp(Math.PI / 2, -Math.PI / 2, Math.min(kickT / 0.8, 1.0));
      } else if (kickT < 2.3) {
        // Wind-up
        const w = (kickT - 1.2) / 1.1;
        posX = targetKickStopX;
        posY = standingPelvisY;
        rotY = -Math.PI / 2;
        torsoPitch = -0.25;
        rHipX = THREE.MathUtils.lerp(0, 0.55, w);
        rKneeX = THREE.MathUtils.lerp(0, 0.95, w);
        lShoulderZ = 0.35;
        rShoulderZ = -0.35;
      } else if (kickT < 2.6) {
        // KICK: foot makes contact with the book
        rotY = -Math.PI / 2;
        posX = rightmostBookEdgeX + 0.04;
        rHipX = -1.18;
        rKneeX = 0.02;
        torsoPitch = 0.22;
      } else {
        // Recoil
        rotY = -Math.PI / 2;
        const recU = THREE.MathUtils.clamp((kickT - 2.6) / 2.9, 0, 1);
        posX = (rightmostBookEdgeX + 0.04) + (recU * 0.22);
        posY = standingPelvisY + Math.abs(Math.sin((kickT - 2.6) * 12.0)) * 0.03;

        rHipX = THREE.MathUtils.lerp(-0.6, 0.1, recU);
        rKneeX = THREE.MathUtils.lerp(1.1, 0.2, recU);
        torsoPitch = Math.sin((kickT - 2.6) * 16.0) * 0.18;
        lShoulderZ = Math.sin((kickT - 2.6) * 14.0) * 0.5;
        rShoulderZ = -Math.sin((kickT - 2.6) * 14.0) * 0.5;
        headRoll = Math.sin((kickT - 2.6) * 12.0) * 0.25;
      }
    } else if (t < 56.5) {
      // 9. Departure
      const departU = (t - 49.5) / 7.0;
      const startX = rightmostBookEdgeX + 0.28;
      posX = THREE.MathUtils.lerp(startX, 6.4, departU);
      posZ = WALK_LANE_Z;
      rotY = Math.PI / 2;
      applyWalkCycle(6.8, 0.65);

      if (departU > 0.65) {
        targetOpacity = 1.0 - (departU - 0.65) / 0.35;
      }
    } else {
      sequenceActive.current = false;
      idleTimer.current = 0;
      setVisible(false);
      return;
    }

    // Apply Root Transforms
    rootRef.current.position.set(posX, posY, posZ);
    rootRef.current.rotation.y = rotY;

    // Apply Skeletal Angles with Smooth Damping
    if (torsoRef.current) {
      torsoRef.current.rotation.x = THREE.MathUtils.lerp(torsoRef.current.rotation.x, torsoPitch, dt * 10);
      torsoRef.current.rotation.z = THREE.MathUtils.lerp(torsoRef.current.rotation.z, torsoRoll, dt * 10);
      torsoRef.current.scale.set(squashXZ, squashY, squashXZ);
    }
    if (headRef.current) {
      headRef.current.rotation.x = THREE.MathUtils.lerp(headRef.current.rotation.x, headPitch, dt * 10);
      headRef.current.rotation.y = THREE.MathUtils.lerp(headRef.current.rotation.y, headYaw, dt * 10);
      headRef.current.rotation.z = THREE.MathUtils.lerp(headRef.current.rotation.z, headRoll, dt * 10);
    }

    if (leftShoulderRef.current) {
      leftShoulderRef.current.rotation.x = THREE.MathUtils.lerp(leftShoulderRef.current.rotation.x, lShoulderX, dt * 12);
      leftShoulderRef.current.rotation.z = THREE.MathUtils.lerp(leftShoulderRef.current.rotation.z, lShoulderZ, dt * 12);
    }
    if (rightShoulderRef.current) {
      rightShoulderRef.current.rotation.x = THREE.MathUtils.lerp(rightShoulderRef.current.rotation.x, rShoulderX, dt * 12);
      rightShoulderRef.current.rotation.z = THREE.MathUtils.lerp(rightShoulderRef.current.rotation.z, rShoulderZ, dt * 12);
    }
    if (leftElbowRef.current) leftElbowRef.current.rotation.x = THREE.MathUtils.lerp(leftElbowRef.current.rotation.x, lElbowX, dt * 12);
    if (rightElbowRef.current) rightElbowRef.current.rotation.x = THREE.MathUtils.lerp(rightElbowRef.current.rotation.x, rElbowX, dt * 12);

    if (leftHipRef.current) leftHipRef.current.rotation.x = THREE.MathUtils.lerp(leftHipRef.current.rotation.x, lHipX, dt * 14);
    if (rightHipRef.current) rightHipRef.current.rotation.x = THREE.MathUtils.lerp(rightHipRef.current.rotation.x, rHipX, dt * 14);
    if (leftKneeRef.current) leftKneeRef.current.rotation.x = THREE.MathUtils.lerp(leftKneeRef.current.rotation.x, lKneeX, dt * 14);
    if (rightKneeRef.current) rightKneeRef.current.rotation.x = THREE.MathUtils.lerp(rightKneeRef.current.rotation.x, rKneeX, dt * 14);

    characterMaterial.opacity = THREE.MathUtils.lerp(characterMaterial.opacity, targetOpacity, dt * 6.0);
  });

  if (!visible) return null;

  return (
    <group ref={rootRef} scale={[0.82, 0.82, 0.82]}>
      {/* Pelvis Center */}
      <group ref={pelvisRef} position={[0, 0, 0]}>
        
        {/* Seamless Soft Baymax Torso */}
        <group ref={torsoRef} position={[0, 0, 0]}>
          <mesh geometry={geoms.bellyCap} material={characterMaterial} position={[0, 0.05, 0.005]} castShadow />
          <mesh geometry={geoms.torsoMain} material={characterMaterial} position={[0, 0.11, 0]} castShadow />

          {/* Smooth floating head */}
          <group ref={headRef} position={[0, 0.20, 0]}>
            <mesh geometry={geoms.head} material={characterMaterial} position={[0, 0.03, 0]} castShadow />
          </group>

          {/* Left Arm: Continuous capsule limb */}
          <group ref={leftShoulderRef} position={[-0.082, 0.14, 0]}>
            <mesh geometry={geoms.armSegment} material={characterMaterial} position={[0, -0.04, 0]} castShadow />
            <mesh geometry={geoms.armCap} material={characterMaterial} position={[0, 0, 0]} />
            <group ref={leftElbowRef} position={[0, -0.075, 0]}>
              <mesh geometry={geoms.armSegment} material={characterMaterial} position={[0, -0.038, 0]} castShadow />
              <mesh geometry={geoms.armCap} material={characterMaterial} position={[0, -0.078, 0]} castShadow />
            </group>
          </group>

          {/* Right Arm: Continuous capsule limb */}
          <group ref={rightShoulderRef} position={[0.082, 0.14, 0]}>
            <mesh geometry={geoms.armSegment} material={characterMaterial} position={[0, -0.04, 0]} castShadow />
            <mesh geometry={geoms.armCap} material={characterMaterial} position={[0, 0, 0]} />
            <group ref={rightElbowRef} position={[0, -0.075, 0]}>
              <mesh geometry={geoms.armSegment} material={characterMaterial} position={[0, -0.038, 0]} castShadow />
              <mesh geometry={geoms.armCap} material={characterMaterial} position={[0, -0.078, 0]} castShadow />
            </group>
          </group>
        </group>

        {/* Left Leg: Seamless capsule */}
        <group ref={leftHipRef} position={[-0.042, 0, 0]}>
          <mesh geometry={geoms.legSegment} material={characterMaterial} position={[0, -0.04, 0]} castShadow />
          <group ref={leftKneeRef} position={[0, -0.07, 0]}>
            <mesh geometry={geoms.legSegment} material={characterMaterial} position={[0, -0.035, 0]} castShadow />
            <mesh geometry={geoms.footCap} material={characterMaterial} position={[0, -0.07, 0.006]} castShadow />
          </group>
        </group>

        {/* Right Leg: Seamless capsule */}
        <group ref={rightHipRef} position={[0.042, 0, 0]}>
          <mesh geometry={geoms.legSegment} material={characterMaterial} position={[0, -0.04, 0]} castShadow />
          <group ref={rightKneeRef} position={[0, -0.07, 0]}>
            <mesh geometry={geoms.legSegment} material={characterMaterial} position={[0, -0.035, 0]} castShadow />
            <mesh geometry={geoms.footCap} material={characterMaterial} position={[0, -0.07, 0.006]} castShadow />
          </group>
        </group>
      </group>
    </group>
  );
}