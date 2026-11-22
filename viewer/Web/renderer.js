const vertexSource = `#version 300 es
  in vec3 position;
  uniform vec3 center;
  uniform float inverseRadius;
  uniform mat3 rotation;
  uniform vec2 scale;
  uniform vec2 pan;
  out vec3 eyePosition;
  void main() {
    eyePosition = rotation * ((position - center) * inverseRadius);
    gl_Position = vec4(eyePosition.xy * scale + pan, -eyePosition.z * 0.34, 1.0);
  }`;

const fragmentSource = `#version 300 es
  precision highp float;
  in vec3 eyePosition;
  uniform bool gridPass;
  out vec4 rgba;
  void main() {
    if (gridPass) {
      rgba = vec4(0.55, 0.65, 0.77, 0.22);
    } else {
      vec3 normal = normalize(cross(dFdx(eyePosition), dFdy(eyePosition)));
      vec3 light = normalize(vec3(-0.52, 0.64, 0.79));
      float shade = 0.43 + 0.53 * max(dot(normal, light), 0.0);
      float highlight = 0.13 * pow(max(dot(normal, normalize(light + vec3(0, 0, 1))), 0.0), 24.0);
      rgba = vec4(vec3(0.98, 0.70, 0.35) * shade + highlight, 1.0);
    }
  }`;

const presets = {
  orbit: [-0.62, 0.93],
  top: [0, 0],
  front: [0, Math.PI / 2],
};

export class MeshRenderer {
  constructor(canvas, axes) {
    this.canvas = canvas;
    this.axes = axes;
    this.gl = canvas.getContext('webgl2', {antialias: true});
    if (!this.gl) throw new Error('Не удалось включить WebGL для 3D-просмотра.');

    const gl = this.gl;
    this.program = createProgram(gl);
    this.position = gl.getAttribLocation(this.program, 'position');
    this.uniforms = Object.fromEntries(['center', 'inverseRadius', 'rotation', 'scale', 'pan', 'gridPass']
      .map(name => [name, gl.getUniformLocation(this.program, name)]));
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this.setView('orbit');
    new ResizeObserver(() => this.invalidate()).observe(canvas);
  }

  load(mesh) {
    const {lower, upper, positions} = mesh;
    const extents = upper.map((value, axis) => value - lower[axis]);
    const center = upper.map((value, axis) => lower[axis] + extents[axis] / 2);
    const vertexBuffer = this.buffer(positions);
    if (this.gl.getError() !== this.gl.NO_ERROR) {
      this.gl.deleteBuffer(vertexBuffer);
      throw new Error('Не хватило видеопамяти для загрузки модели.');
    }

    this.gl.deleteBuffer(this.mesh?.buffer ?? null);
    this.gl.deleteBuffer(this.grid?.buffer ?? null);
    const grid = makeGrid(center, lower[2], extents);
    this.grid = {buffer: this.buffer(grid), count: grid.length / 3};
    const inverseRadius = 2 / Math.hypot(...extents);
    this.mesh = {
      buffer: vertexBuffer, count: positions.length / 3, center, inverseRadius,
      halfExtents: extents.map(extent => extent * inverseRadius / 2),
    };
    this.setView('orbit');
  }

  buffer(positions) {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    return buffer;
  }

  setView(view) {
    [this.yaw, this.pitch] = presets[view];
    this.fit();
  }

  fit() {
    this.zoom = 1;
    if (this.mesh) {
      const aspect = Math.max(1, this.canvas.clientWidth) / Math.max(1, this.canvas.clientHeight);
      const rotation = this.rotation();
      const [x, y] = [0, 1].map(row => this.mesh.halfExtents.reduce(
        (radius, extent, axis) => radius + extent * Math.abs(rotation[axis * 3 + row]), 0));
      const projectedRadius = Math.max(x * Math.min(1, 1 / aspect), y * Math.min(1, aspect));
      this.zoom = Math.min(30, 0.87 / projectedRadius);
    }
    this.panX = 0;
    this.panY = 0;
    this.invalidate();
  }

  rotate(dx, dy) {
    this.yaw += dx * 0.009;
    this.pitch = Math.max(-Math.PI, Math.min(Math.PI, this.pitch - dy * 0.009));
    this.invalidate();
  }

  panBy(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    this.invalidate();
  }

  scaleBy(factor) {
    this.zoom = Math.max(0.18, Math.min(30, this.zoom * factor));
    this.invalidate();
  }

  invalidate() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  rotation() {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    return [c, cp * s, -sp * s, -s, cp * c, -sp * c, 0, sp, cp];
  }

  draw() {
    const {gl, canvas, uniforms} = this;
    const ratio = Math.min(window.devicePixelRatio, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.mesh) return;

    const rotation = this.rotation();
    gl.useProgram(this.program);
    gl.uniform3fv(uniforms.center, this.mesh.center);
    gl.uniform1f(uniforms.inverseRadius, this.mesh.inverseRadius);
    gl.uniformMatrix3fv(uniforms.rotation, false, rotation);
    gl.uniform2f(uniforms.scale, this.zoom * Math.min(1, height / width), this.zoom * Math.min(1, width / height));
    gl.uniform2f(uniforms.pan, 2 * this.panX / canvas.clientWidth, -2 * this.panY / canvas.clientHeight);

    gl.enable(gl.BLEND);
    gl.uniform1i(uniforms.gridPass, true);
    this.drawBuffer(this.grid, gl.LINES);
    gl.disable(gl.BLEND);
    gl.uniform1i(uniforms.gridPass, false);
    this.drawBuffer(this.mesh, gl.TRIANGLES);
    drawAxes(this.axes, rotation);
  }

  drawBuffer(geometry, primitive) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, geometry.buffer);
    gl.enableVertexAttribArray(this.position);
    gl.vertexAttribPointer(this.position, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(primitive, 0, geometry.count);
  }
}

function createProgram(gl) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  return program;
}

function makeGrid(center, base, extents) {
  const span = Math.max(...extents);
  const desiredStep = span / 11;
  const magnitude = 10 ** Math.floor(Math.log10(desiredStep));
  const step = [1, 2, 5, 10].find(factor => factor * magnitude >= desiredStep) * magnitude;
  const divisions = Math.ceil(span * 0.58 / step);
  const edge = step * divisions;
  const [x, y] = center;
  const z = base - span * 0.022;
  const lines = [];
  for (let i = -divisions; i <= divisions; i++) {
    const offset = i * step;
    lines.push(x + offset, y - edge, z, x + offset, y + edge, z);
    lines.push(x - edge, y + offset, z, x + edge, y + offset, z);
  }
  return new Float32Array(lines);
}

function drawAxes(canvas, rotation) {
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, 72, 72);
  context.font = '600 11px Segoe UI';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const [axis, label, color] of [[0, 'X', '#eb8a83'], [1, 'Y', '#85cfac'], [2, 'Z', '#92bcf4']]) {
    const x = rotation[axis * 3];
    const y = -rotation[axis * 3 + 1];
    context.strokeStyle = context.fillStyle = color;
    if (Math.hypot(x, y) < 0.12) {
      context.fillText(label, 36, 36);
      continue;
    }
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(36, 36);
    context.lineTo(36 + x * 21, 36 + y * 21);
    context.stroke();
    context.fillText(label, 36 + x * 29, 36 + y * 29);
  }
}
