import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  SCENE_EARTH_RADIUS,
  KM_TO_SCENE,
  computeSubsolarPoint,
  geodeticToScenePosition,
  computeSunECI,
  computePlanetHeliocentricXYZ,
} from './utils.js';

const TEXTURE_BASE = 'https://threejs.org/examples/textures/planets/';

// Earth surface shader: blends a lit "day" texture with an emissive "night
// lights" texture based on how directly each fragment's normal faces the
// sun, and adds a soft specular highlight over oceans (using the specular
// mask texture to exclude land).
const EARTH_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;

  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vec4 mvPosition = viewMatrix * worldPosition;
    vViewDir = normalize(cameraPosition - worldPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const EARTH_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform sampler2D specularMap;
  uniform vec3 sunDirection;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;

  void main() {
    vec3 normal = normalize(vNormalW);
    float sunFacing = dot(normal, normalize(sunDirection));

    vec3 dayColor = texture2D(dayMap, vUv).rgb;
    vec3 nightColor = texture2D(nightMap, vUv).rgb * vec3(1.15, 1.0, 0.75) * 1.8;
    float oceanMask = texture2D(specularMap, vUv).r;

    // Smooth terminator: blend across a narrow band around the sunrise/sunset line.
    float dayMix = smoothstep(-0.15, 0.2, sunFacing);
    vec3 color = mix(nightColor, dayColor, dayMix);

    // Specular ocean highlight, masked so it doesn't glint off land.
    vec3 halfVec = normalize(normalize(sunDirection) + vViewDir);
    float specAngle = max(dot(normal, halfVec), 0.0);
    float specular = pow(specAngle, 28.0) * oceanMask * clamp(sunFacing * 3.0, 0.0, 1.0);
    color += vec3(0.55, 0.6, 0.65) * specular * 0.6;

    // Faint ambient fill so the night side isn't pure black.
    color += dayColor * 0.02;

    gl_FragColor = vec4(color, 1.0);
  }
`;

// Thin additive rim-light shell that reads as atmospheric glow.
const ATMOSPHERE_VERTEX_SHADER = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  void main() {
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vViewDir = normalize(cameraPosition - worldPosition.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;
const ATMOSPHERE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 glowColor;
  uniform vec3 sunDirection;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  void main() {
    float rim = 1.0 - max(dot(normalize(vNormalW), normalize(vViewDir)), 0.0);
    float intensity = pow(rim, 2.6);
    float sunSide = clamp(dot(normalize(vNormalW), normalize(sunDirection)) * 0.5 + 0.6, 0.15, 1.0);
    gl_FragColor = vec4(glowColor * intensity * sunSide, intensity * 0.9);
  }
`;

// Vertex-colored, per-vertex-alpha line used for satellite ground-track trails.
const TRAIL_VERTEX_SHADER = /* glsl */ `
  attribute float alpha;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = alpha;
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const TRAIL_FRAGMENT_SHADER = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, vAlpha);
  }
`;

export class OrbitalScene {
  /**
   * @param {HTMLElement} container Element the WebGL canvas will be mounted into.
   */
  constructor(container) {
    this.container = container;
    this.clock = new THREE.Clock();

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      0.1,
      6000   // extended to see Neptune at ~2400 scene units
    );
    this.camera.position.set(0, 6, 16);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = SCENE_EARTH_RADIUS + 0.3;
    this.controls.maxDistance = 3000;  // allows pulling back to see the solar system
    this.controls.rotateSpeed = 0.45;
    this.controls.zoomSpeed = 0.7;

    this._followTarget = null; // {getPosition(): {x,y,z}} while camera-locked on a satellite
    this._followDistance = SCENE_EARTH_RADIUS * 0.6;

    this._buildLighting();
    this._buildStarfield();
    this._buildEarth();
    this._buildSolarSystem();
    this._buildSelectionMarker();

    this._satelliteLayers = new Map(); // groupKey -> {points, geometry, material, capacity}
    this._trail = null;

    window.addEventListener('resize', () => this._onResize());
    this._onResize();
  }

  _buildLighting() {
    this.sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sunLight.position.set(10, 0, 0);
    this.scene.add(this.sunLight);
    this.scene.add(new THREE.AmbientLight(0x1a2438, 0.6));
  }

  _buildStarfield() {
    // Procedural starfield: avoids relying on an external texture and gives
    // full control over density/brightness/color temperature.
    const STAR_COUNT = 9000;
    const positions = new Float32Array(STAR_COUNT * 3);
    const colors = new Float32Array(STAR_COUNT * 3);
    const radius = 600;

    for (let i = 0; i < STAR_COUNT; i++) {
      // Uniform distribution on a sphere shell.
      const u = Math.random();
      const v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      const r = radius * (0.85 + Math.random() * 0.15);
      const x = r * Math.sin(phi) * Math.cos(theta);
      const y = r * Math.sin(phi) * Math.sin(theta);
      const z = r * Math.cos(phi);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      // Slight warm/cool color variance, like real starlight.
      const temp = Math.random();
      const brightness = 0.6 + Math.random() * 0.4;
      colors[i * 3] = brightness * (0.85 + temp * 0.25);
      colors[i * 3 + 1] = brightness * (0.9 + temp * 0.1);
      colors[i * 3 + 2] = brightness * (1.0 - temp * 0.15);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 1.15,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
    });

    this.stars = new THREE.Points(geometry, material);
    this.scene.add(this.stars);
  }

  _buildEarth() {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');

    const dayMap = loader.load(`${TEXTURE_BASE}earth_atmos_2048.jpg`);
    const nightMap = loader.load(`${TEXTURE_BASE}earth_lights_2048.png`);
    const specularMap = loader.load(`${TEXTURE_BASE}earth_specular_2048.jpg`);
    const cloudsMap = loader.load(`${TEXTURE_BASE}earth_clouds_1024.png`);
    [dayMap, nightMap, specularMap, cloudsMap].forEach((tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
    });

    this.earthGroup = new THREE.Group();
    this.scene.add(this.earthGroup);

    this.earthUniforms = {
      dayMap: { value: dayMap },
      nightMap: { value: nightMap },
      specularMap: { value: specularMap },
      sunDirection: { value: new THREE.Vector3(1, 0, 0) },
    };

    const earthGeometry = new THREE.SphereGeometry(SCENE_EARTH_RADIUS, 96, 96);
    const earthMaterial = new THREE.ShaderMaterial({
      uniforms: this.earthUniforms,
      vertexShader: EARTH_VERTEX_SHADER,
      fragmentShader: EARTH_FRAGMENT_SHADER,
    });
    this.earthMesh = new THREE.Mesh(earthGeometry, earthMaterial);
    this.earthGroup.add(this.earthMesh);

    // Cloud layer: slightly larger radius, slow independent drift.
    const cloudGeometry = new THREE.SphereGeometry(SCENE_EARTH_RADIUS * 1.008, 96, 96);
    const cloudMaterial = new THREE.MeshLambertMaterial({
      map: cloudsMap,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    this.cloudMesh = new THREE.Mesh(cloudGeometry, cloudMaterial);
    this.earthGroup.add(this.cloudMesh);

    // Atmosphere glow shell.
    const atmosphereGeometry = new THREE.SphereGeometry(SCENE_EARTH_RADIUS * 1.06, 96, 96);
    const atmosphereMaterial = new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color(0x4fb8ff) },
        sunDirection: this.earthUniforms.sunDirection,
      },
      vertexShader: ATMOSPHERE_VERTEX_SHADER,
      fragmentShader: ATMOSPHERE_FRAGMENT_SHADER,
      transparent: true,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.atmosphereMesh = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
    this.earthGroup.add(this.atmosphereMesh);
  }

  _buildSelectionMarker() {
    const geometry = new THREE.RingGeometry(0.09, 0.13, 32);
    const material = new THREE.MeshBasicMaterial({
      color: 0xe8a33d,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    this.selectionMarker = new THREE.Mesh(geometry, material);
    this.selectionMarker.visible = false;
    this.selectionMarker.renderOrder = 10;
    this.scene.add(this.selectionMarker);

    const coreGeometry = new THREE.SphereGeometry(0.045, 16, 16);
    const coreMaterial = new THREE.MeshBasicMaterial({ color: 0xfff2d9, depthTest: false });
    this.selectionCore = new THREE.Mesh(coreGeometry, coreMaterial);
    this.selectionCore.visible = false;
    this.selectionCore.renderOrder = 10;
    this.scene.add(this.selectionCore);
  }

  /**
   * Updates the sun's direction (and therefore the day/night terminator,
   * ocean specular highlight, and atmosphere shading) for the given
   * simulated Date.
   * @param {Date} simDate
   */
  updateSunPosition(simDate) {
    const { lat, lon } = computeSubsolarPoint(simDate);
    const p = geodeticToScenePosition(lat, lon, 0);
    const dir = new THREE.Vector3(p.x, p.y, p.z).normalize();
    this.earthUniforms.sunDirection.value.copy(dir);
    this.sunLight.position.copy(dir).multiplyScalar(50);
  }

  // ---------------------------------------------------------------------------
  // Solar system
  // ---------------------------------------------------------------------------

  /**
   * Visual + physical scale constants.
   * 1 AU = SCENE_AU scene units (80 keeps planets well outside Earth's orbit
   * at ~5 scene units).  Sun size is boosted for visibility.
   */
  static get SCENE_AU() { return 80; }

  _buildSolarSystem() {
    this._solarGroup = new THREE.Group();
    this.scene.add(this._solarGroup);

    // ---- Sun ----------------------------------------------------------------
    // Custom glowing-corona shader — renders an additive halo around the core.
    const sunCoreMat = new THREE.MeshBasicMaterial({ color: 0xffe87a });
    const sunCoreGeo = new THREE.SphereGeometry(3.2, 32, 32);
    this._sunMesh = new THREE.Mesh(sunCoreGeo, sunCoreMat);
    this._solarGroup.add(this._sunMesh);

    // Corona glow (additive sphere slightly larger than core)
    const coronaMat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(0xff9922) } },
      vertexShader: /* glsl */`
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vView   = normalize(-vec3(modelViewMatrix * vec4(position,1.0)));
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 color;
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          float rim = 1.0 - max(dot(vNormal, vView), 0.0);
          float glow = pow(rim, 2.2);
          gl_FragColor = vec4(color * glow, glow * 0.75);
        }`,
      transparent: true,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const coronaGeo = new THREE.SphereGeometry(3.2 * 2.6, 32, 32);
    this._solarGroup.add(new THREE.Mesh(coronaGeo, coronaMat));

    // Point light emitted from the Sun
    this._sunPointLight = new THREE.PointLight(0xffe8a0, 3.0, 0, 1.5);
    this._solarGroup.add(this._sunPointLight);

    // ---- Planets ------------------------------------------------------------
    const PLANET_DEFS = [
      { name: 'mercury', color: 0xa89070, radius: 0.35, ringConfig: null },
      { name: 'venus',   color: 0xe8c87a, radius: 0.55, ringConfig: null },
      // Earth is always at origin; skip heliocentric placement.
      { name: 'mars',    color: 0xd0563a, radius: 0.42, ringConfig: null },
      { name: 'jupiter', color: 0xc8a870, radius: 1.50, ringConfig: null },
      { name: 'saturn',  color: 0xe0d090, radius: 1.20,
        ringConfig: { inner: 1.55, outer: 2.65, color: 0xd8c890 } },
      { name: 'uranus',  color: 0x7adce8, radius: 0.85, ringConfig: null },
      { name: 'neptune', color: 0x4a6be8, radius: 0.80, ringConfig: null },
    ];

    this._planetMeshes  = {};
    this._orbitLines    = {};

    // Subtle ecliptic-plane grid for orientation
    const gridMat = new THREE.LineBasicMaterial({ color: 0x1a2840, transparent: true, opacity: 0.35, depthWrite: false });

    for (const def of PLANET_DEFS) {
      // Planet sphere
      const geo = new THREE.SphereGeometry(def.radius, 24, 24);
      const mat = new THREE.MeshStandardMaterial({
        color: def.color,
        roughness: 0.7,
        metalness: 0.05,
        emissive: new THREE.Color(def.color).multiplyScalar(0.15),
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = false;
      this._solarGroup.add(mesh);
      this._planetMeshes[def.name] = mesh;

      // Saturn rings
      if (def.ringConfig) {
        const ringGeo = new THREE.RingGeometry(def.ringConfig.inner, def.ringConfig.outer, 80);
        // RingGeometry UVs map radially; tilt to match Saturn's axial tilt (~27°)
        const ringMat = new THREE.MeshBasicMaterial({
          color: def.ringConfig.color,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
        });
        const ringMesh = new THREE.Mesh(ringGeo, ringMat);
        ringMesh.rotation.x = Math.PI / 2 - 0.47; // ~27° tilt
        mesh.add(ringMesh);
      }

      // Orbit path circle (approximate as ellipse with 256 segments)
      const orbitPts = [];
      for (let i = 0; i <= 256; i++) {
        const theta = (i / 256) * Math.PI * 2;
        // We'll update the actual path in updateSolarSystem; placeholder
        orbitPts.push(new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta)));
      }
      const orbitGeo = new THREE.BufferGeometry().setFromPoints(orbitPts);
      const orbitLine = new THREE.LineLoop(orbitGeo, gridMat.clone());
      this._solarGroup.add(orbitLine);
      this._orbitLines[def.name] = orbitLine;
    }
  }

  /**
   * Moves the Sun and all planets to their astronomically correct positions
   * for the given simulation Date. Call once per propagation tick.
   * @param {Date} simDate
   */
  updateSolarSystem(simDate) {
    const AU = OrbitalScene.SCENE_AU;

    // Sun position: geocentric, pointing away from where sunlight comes from.
    // Earth is at the scene origin; Sun is at -sunDirection * 1 AU.
    const sunDir = computeSunECI(simDate);
    const sunPos = new THREE.Vector3(-sunDir.x * AU, -sunDir.y * AU, -sunDir.z * AU);
    this._sunMesh.position.copy(sunPos);
    this._sunPointLight.position.copy(sunPos);

    // Update sun light to come from the correct direction
    this.sunLight.position.set(sunDir.x * 50, sunDir.y * 50, sunDir.z * 50);
    this.earthUniforms.sunDirection.value.set(sunDir.x, sunDir.y, sunDir.z);

    // Planets: compute heliocentric XYZ then offset to geocentric
    const earthHel = computePlanetHeliocentricXYZ('earth', simDate, AU);
    const PLANETS = ['mercury','venus','mars','jupiter','saturn','uranus','neptune'];

    for (const name of PLANETS) {
      const mesh  = this._planetMeshes[name];
      const orbit = this._orbitLines[name];
      if (!mesh) continue;

      const hel = computePlanetHeliocentricXYZ(name, simDate, AU);
      // Geocentric position = heliocentric_planet − heliocentric_earth
      const geoX = hel.x - earthHel.x;
      const geoY = hel.y - earthHel.y;
      const geoZ = hel.z - earthHel.z;
      mesh.position.set(geoX, geoY, geoZ);

      // Slowly spin each planet for visual interest
      mesh.rotation.y += 0.002;

      // Orbit ring: a circle around the geocentric Sun at the planet's
      // heliocentric distance (magnitude of heliocentric vector), drawn
      // in the ecliptic plane (XZ in scene frame, Y ≈ 0 at ecliptic).
      if (orbit) {
        const helDist = Math.sqrt(hel.x ** 2 + hel.y ** 2 + hel.z ** 2);
        const pos = orbit.geometry.attributes.position;
        for (let i = 0; i <= 256; i++) {
          const theta = (i / 256) * Math.PI * 2;
          pos.setXYZ(i,
            sunPos.x + Math.cos(theta) * helDist,
            sunPos.y,                              // keep in ecliptic plane
            sunPos.z + Math.sin(theta) * helDist,
          );
        }
        pos.needsUpdate = true;
      }
    }
  }


  /**
   * Registers (or returns the existing) GPU point layer for a satellite
   * group, sized to `capacity` points. Call `updateGroupPositions` each
   * propagation tick to move the points.
   * @param {string} groupKey
   * @param {string} colorHex e.g. "#4FD1C5"
   * @param {number} capacity maximum number of satellites in this group
   */
  ensureSatelliteLayer(groupKey, colorHex, capacity) {
    if (this._satelliteLayers.has(groupKey)) return this._satelliteLayers.get(groupKey);

    const positions = new Float32Array(capacity * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setDrawRange(0, 0);

    const material = new THREE.PointsMaterial({
      color: new THREE.Color(colorHex),
      size: 0.065,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    this.scene.add(points);

    const layer = { points, geometry, material, capacity };
    this._satelliteLayers.set(groupKey, layer);
    return layer;
  }

  /**
   * Uploads a fresh batch of scene-space positions for a satellite group.
   * @param {string} groupKey
   * @param {Float32Array} flatXYZ positions, length = count*3
   * @param {number} count number of valid satellites in flatXYZ
   */
  updateGroupPositions(groupKey, flatXYZ, count) {
    const layer = this._satelliteLayers.get(groupKey);
    if (!layer) return;
    const attr = layer.geometry.getAttribute('position');
    attr.array.set(flatXYZ.subarray(0, count * 3));
    attr.needsUpdate = true;
    layer.geometry.setDrawRange(0, count);
    layer.geometry.computeBoundingSphere();
  }

  setLayerVisible(groupKey, visible) {
    const layer = this._satelliteLayers.get(groupKey);
    if (layer) layer.points.visible = visible;
  }

  /** Moves the ring/core selection marker to a scene-space position, or hides it. */
  setSelectionPosition(pos) {
    if (!pos) {
      this.selectionMarker.visible = false;
      this.selectionCore.visible = false;
      return;
    }
    this.selectionMarker.visible = true;
    this.selectionCore.visible = true;
    this.selectionMarker.position.set(pos.x, pos.y, pos.z);
    this.selectionCore.position.set(pos.x, pos.y, pos.z);
    this.selectionMarker.lookAt(0, 0, 0);
  }

  /**
   * Draws (or clears) the ground-track trail for the selected satellite.
   * @param {Array<{x:number,y:number,z:number}>|null} points ordered along the track
   * @param {string} colorHex
   */
  setTrail(points, colorHex) {
    if (this._trail) {
      this.scene.remove(this._trail);
      this._trail.geometry.dispose();
      this._trail.material.dispose();
      this._trail = null;
    }
    if (!points || points.length < 2) return;

    const n = points.length;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const alphas = new Float32Array(n);
    const color = new THREE.Color(colorHex);

    for (let i = 0; i < n; i++) {
      positions[i * 3] = points[i].x;
      positions[i * 3 + 1] = points[i].y;
      positions[i * 3 + 2] = points[i].z;
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
      // Fade in from the tail toward the current position (assumed last point).
      alphas[i] = 0.08 + 0.82 * (i / (n - 1));
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));

    const material = new THREE.ShaderMaterial({
      vertexShader: TRAIL_VERTEX_SHADER,
      fragmentShader: TRAIL_FRAGMENT_SHADER,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });

    this._trail = new THREE.Line(geometry, material);
    this.scene.add(this._trail);
  }

  /** Smoothly points the camera at a scene position and keeps it centered on the target each frame. */
  followPosition(pos) {
    if (!pos) {
      this._followTarget = null;
      return;
    }
    this._followTarget = pos;
  }

  clearFollow() {
    this._followTarget = null;
  }

  /** Animates the OrbitControls target toward the origin and resets zoom. */
  resetCamera() {
    this._followTarget = null;
    this._resetAnimation = { start: performance.now(), duration: 900, from: this.controls.target.clone(), fromPos: this.camera.position.clone() };
  }

  _onResize() {
    const { clientWidth, clientHeight } = this.container;
    this.camera.aspect = clientWidth / Math.max(clientHeight, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(clientWidth, clientHeight);
  }

  /** Call once per animation frame. */
  render() {
    const dt = this.clock.getDelta();

    this.cloudMesh.rotation.y += dt * 0.008;
    this.stars.rotation.y += dt * 0.0006;

    if (this._followTarget) {
      const t = this._followTarget;
      this.controls.target.lerp(new THREE.Vector3(t.x, t.y, t.z), 0.12);
    }

    if (this._resetAnimation) {
      const elapsed = performance.now() - this._resetAnimation.start;
      const p = Math.min(elapsed / this._resetAnimation.duration, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      this.controls.target.lerpVectors(this._resetAnimation.from, new THREE.Vector3(0, 0, 0), ease);
      const targetPos = new THREE.Vector3(0, 6, 16);
      this.camera.position.lerpVectors(this._resetAnimation.fromPos, targetPos, ease);
      if (p >= 1) this._resetAnimation = null;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** Converts a normalized device (-1..1) click coordinate into candidate raycast hits across all satellite layers. */
  raycastSatellites(ndcX, ndcY) {
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 0.09;
    raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);

    let best = null;
    for (const [groupKey, layer] of this._satelliteLayers) {
      if (!layer.points.visible) continue;
      const hits = raycaster.intersectObject(layer.points, false);
      if (hits.length > 0) {
        const hit = hits[0];
        if (!best || hit.distance < best.distance) {
          best = { groupKey, index: hit.index, distance: hit.distance };
        }
      }
    }
    return best;
  }
}
