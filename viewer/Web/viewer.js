import {MeshRenderer} from './renderer.js';

const byId = id => document.getElementById(id);
const stage = byId('stage');
const viewport = byId('viewport');
const axes = byId('axes');
const filePicker = byId('file-picker');
const sampleList = byId('sample-list');
const message = byId('model-message');
const viewButtons = Array.from(document.querySelectorAll('[data-view]'));
const dimensions = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2});
const counts = new Intl.NumberFormat('ru-RU');

let renderer;
let worker;
let gesture;

function showMessage(text, error = false) {
  message.textContent = text;
  message.hidden = !text;
  message.dataset.error = String(error);
}

function chooseView(view) {
  for (const button of viewButtons) button.setAttribute('aria-pressed', String(button.dataset.view === view));
}

function loadModel(source, label, detail, selected) {
  worker?.terminate();
  stage.setAttribute('aria-busy', 'true');
  showMessage(`Открываю ${label}…`);
  const task = new Worker('/mesh-worker.js');
  worker = task;

  function finish() {
    if (worker !== task) return false;
    task.terminate();
    worker = undefined;
    stage.setAttribute('aria-busy', 'false');
    return true;
  }

  task.onmessage = ({data}) => {
    if (!finish()) return;
    if (data.error) {
      showMessage(data.error, true);
      return;
    }
    try {
      renderer.load(data);
      byId('model-name').textContent = label;
      byId('model-detail').textContent = detail;
      byId('model-detail').hidden = !detail;
      const extents = data.upper.map((value, axis) => dimensions.format(value - data.lower[axis]));
      byId('dimensions').textContent = extents.join(' × ') + (selected ? ' мм' : '');
      byId('triangle-count').textContent = counts.format(data.triangles);
      byId('model-summary').hidden = false;
      byId('controls-help').hidden = false;
      byId('fit').disabled = false;
      axes.hidden = false;
      for (const button of viewButtons) button.disabled = false;
      for (const button of sampleList.children) button.setAttribute('aria-pressed', String(button === selected));
      chooseView('orbit');
      showMessage('');
    } catch (error) {
      showMessage(error.message, true);
    }
  };
  task.onerror = () => {
    if (finish()) showMessage('Не удалось запустить загрузку STL.', true);
  };
  task.postMessage(source);
}

function openFile(file) {
  if (!file) return;
  if (!/\.stl$/i.test(file.name)) {
    showMessage('Выберите файл с расширением .stl.', true);
    return;
  }
  loadModel({file}, file.name, '', null);
}

function wireControls() {
  byId('open-file').addEventListener('click', () => filePicker.click());
  filePicker.addEventListener('change', () => {
    openFile(filePicker.files[0]);
    filePicker.value = '';
  });
  document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.code === 'KeyO') {
      event.preventDefault();
      filePicker.click();
    }
  });

  for (const button of viewButtons) {
    button.addEventListener('click', () => {
      renderer.setView(button.dataset.view);
      chooseView(button.dataset.view);
    });
  }
  byId('fit').addEventListener('click', () => renderer.fit());

  viewport.addEventListener('pointerdown', event => {
    if (!renderer.mesh || gesture || ![0, 1, 2].includes(event.button)) return;
    viewport.focus({preventScroll: true});
    viewport.setPointerCapture(event.pointerId);
    gesture = {id: event.pointerId, x: event.clientX, y: event.clientY, pan: event.button !== 0 || event.shiftKey};
  });
  viewport.addEventListener('pointermove', event => {
    if (gesture?.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    if (gesture.pan) {
      renderer.panBy(dx, dy);
    } else {
      renderer.rotate(dx, dy);
      chooseView('orbit');
    }
  });
  viewport.addEventListener('lostpointercapture', () => { gesture = undefined; });
  viewport.addEventListener('contextmenu', event => event.preventDefault());
  viewport.addEventListener('wheel', event => {
    if (!renderer.mesh) return;
    event.preventDefault();
    renderer.scaleBy(Math.exp(-event.deltaY * 0.0016));
  }, {passive: false});
  viewport.addEventListener('keydown', event => {
    const arrows = {ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, -12], ArrowDown: [0, 12]};
    if (!renderer.mesh) return;
    if (arrows[event.key]) {
      if (event.shiftKey) {
        renderer.panBy(...arrows[event.key]);
      } else {
        renderer.rotate(...arrows[event.key]);
        chooseView('orbit');
      }
    } else if (event.key === '+' || event.key === '=') {
      renderer.scaleBy(1.15);
    } else if (event.key === '-') {
      renderer.scaleBy(1 / 1.15);
    } else if (event.key === 'Home') {
      renderer.fit();
    } else {
      return;
    }
    event.preventDefault();
  });

  document.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = stage.contains(event.target) ? 'copy' : 'none';
    stage.classList.toggle('dragging', stage.contains(event.target));
  });
  document.addEventListener('dragleave', event => {
    if (!stage.contains(event.relatedTarget)) stage.classList.remove('dragging');
  });
  document.addEventListener('drop', event => {
    event.preventDefault();
    stage.classList.remove('dragging');
    if (stage.contains(event.target)) openFile(event.dataTransfer.files[0]);
  });
  viewport.addEventListener('webglcontextlost', () => {
    showMessage('Графический контекст потерян. Перезапустите просмотрщик.', true);
  });
}

async function populateSamples() {
  const response = await fetch('/samples.json');
  if (!response.ok) throw new Error('Список моделей недоступен.');
  const samples = await response.json();
  for (const sample of samples) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sample';
    button.setAttribute('aria-pressed', 'false');
    const label = document.createElement('span');
    label.className = 'sample-label';
    label.textContent = sample.label;
    const detail = document.createElement('span');
    detail.className = 'sample-detail';
    detail.textContent = sample.detail;
    button.append(label, detail);
    button.addEventListener('click', () => {
      loadModel({url: `/samples/${encodeURIComponent(sample.file)}`}, sample.label, sample.detail, button);
    });
    sampleList.append(button);
  }
  byId('no-samples').hidden = samples.length > 0;
  if (!worker && !renderer.mesh) {
    if (samples.length) sampleList.firstElementChild.click();
    else showMessage('Откройте STL или перетащите его сюда.');
  }
}

try {
  renderer = new MeshRenderer(viewport, axes);
  wireControls();
  populateSamples().catch(error => showMessage(error.message, true));
} catch (error) {
  byId('open-file').disabled = true;
  showMessage(error.message, true);
}
