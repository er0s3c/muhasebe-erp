import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
export interface ModelElement {
  guid: string;
  name: string;
  type: string;
  storey: string;
  vertices: number[];
  faces: number[];
}
export function ModelViewer({
  elements,
  selected,
  onSelect,
  colors,
}: {
  elements: ModelElement[];
  selected: string;
  onSelect: (guid: string) => void;
  colors: Record<string, string>;
}) {
  const host = useRef<HTMLDivElement>(null),
    selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  useEffect(() => {
    if (!host.current) return;
    const parent = host.current,
      scene = new THREE.Scene();
    scene.background = new THREE.Color('#e9eff5');
    const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100000);
    camera.up.set(0, 0, 1);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    parent.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x617388, 2));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(50, -50, 100);
    scene.add(light);
    const meshes: THREE.Mesh[] = [];
    for (const e of elements) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(e.vertices, 3));
      geometry.setIndex(e.faces);
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: e.guid === selected ? '#f59e0b' : (colors[e.guid] ?? '#a5b4c4'),
          side: THREE.DoubleSide,
          roughness: 0.7,
        }),
      );
      mesh.userData.guid = e.guid;
      scene.add(mesh);
      meshes.push(mesh);
    }
    const bounds = new THREE.Box3();
    meshes.forEach((m) => bounds.expandByObject(m));
    const center = bounds.getCenter(new THREE.Vector3()),
      size = Math.max(bounds.getSize(new THREE.Vector3()).length(), 1);
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(size * 0.8, -size * 0.8, size * 0.6));
    camera.far = Math.max(1000, size * 100);
    camera.updateProjectionMatrix();
    const resize = () => {
      const w = parent.clientWidth,
        h = parent.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(parent);
    resize();
    let frame = 0;
    const draw = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(draw);
    };
    draw();
    let down = { x: 0, y: 0 };
    const start = (event: PointerEvent) => {
      down = { x: event.clientX, y: event.clientY };
    };
    const choose = (event: PointerEvent) => {
      if (Math.hypot(down.x - event.clientX, down.y - event.clientY) > 6) return;
      const rect = renderer.domElement.getBoundingClientRect(),
        ray = new THREE.Raycaster();
      ray.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          (-(event.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
      const hit = ray.intersectObjects(meshes)[0];
      if (hit) selectRef.current(String(hit.object.userData.guid));
    };
    renderer.domElement.addEventListener('pointerdown', start);
    renderer.domElement.addEventListener('pointerup', choose);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      meshes.forEach((m) => {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [elements, selected, colors]);
  return (
    <div
      ref={host}
      role="img"
      aria-label="IFC proje modeli; eleman seçimi aşağıdaki listeden de yapılabilir"
      className="h-[420px] w-full overflow-hidden rounded-xl border border-border"
    />
  );
}
export function PanoramaViewer({ url }: { url: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const parent = host.current,
      scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
    camera.position.set(0.01, 0, 0);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    parent.appendChild(renderer.domElement);
    const texture = new THREE.TextureLoader().load(url),
      geometry = new THREE.SphereGeometry(10, 64, 40);
    geometry.scale(-1, 1, 1);
    const material = new THREE.MeshBasicMaterial({ map: texture });
    scene.add(new THREE.Mesh(geometry, material));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.rotateSpeed = -0.4;
    const resize = () => {
      renderer.setSize(parent.clientWidth, parent.clientHeight);
      camera.aspect = parent.clientWidth / parent.clientHeight;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(parent);
    resize();
    let frame = 0;
    const draw = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      texture.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [url]);
  return (
    <div
      ref={host}
      className="h-80 w-full rounded-xl"
      role="img"
      aria-label="360 derece fotoğraf; sürükleyerek bakış yönünü değiştirin"
    />
  );
}
