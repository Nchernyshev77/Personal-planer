// Planner — минималистичный трекер задач с перетаскиванием и автосейвом.
// Варианты сохранения:
// 1) Node-сервер (Express) пишет tasks.txt при каждом изменении.
// 2) File System Access API (Chrome/Edge) — прямой автосейв в файл после выбора файла.
// + Всегда есть fallback в localStorage.

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];

const STORAGE_KEY = "planner.tasks.v1";
const UI_KEY = "planner.ui.v1";

const state = {
  tasks: [],
  defaultTag: "none",
  theme: "dark",
  // save modes
  serverConnected: false,
  fileHandle: null,
  lastSavedAt: null,
  saveInFlight: false,
  pip: {
    window: null,
    hostParent: null,
    hostNextSibling: null,
  },
  filter: "",
};

function nowISO(){ return new Date().toISOString(); }

function uid(){
  // crypto.randomUUID available in modern browsers
  return (crypto?.randomUUID?.() ?? ("t_" + Math.random().toString(16).slice(2) + Date.now().toString(16)));
}

function formatTime(iso){
  try{
    const d = new Date(iso);
    return d.toLocaleString(undefined, {year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit"});
  }catch{ return ""; }
}

function serialize(){
  return JSON.stringify({
    version: 1,
    updatedAt: nowISO(),
    tasks: state.tasks,
  }, null, 2);
}

function deserialize(text){
  try{
    const obj = JSON.parse(text);
    if (!obj || !Array.isArray(obj.tasks)) return [];
    // minimal normalization
    return obj.tasks.map(t => ({
      id: String(t.id ?? uid()),
      text: String(t.text ?? ""),
      done: Boolean(t.done),
      tag: ["none","blue","yellow","red","purple"].includes(t.tag) ? t.tag : "none",
      createdAt: t.createdAt ? String(t.createdAt) : nowISO(),
      updatedAt: t.updatedAt ? String(t.updatedAt) : nowISO(),
    })).filter(t => t.text.trim().length > 0);
  }catch{
    return null;
  }
}

function saveToLocalStorage(){
  localStorage.setItem(STORAGE_KEY, serialize());
}

function loadFromLocalStorage(){
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  const tasks = deserialize(raw);
  if (!tasks) return false;
  state.tasks = tasks;
  return true;
}

function setStatus(text){
  const el = $("#saveStatus");
  if (!el) return;
  el.textContent = text;
}

const debouncedSave = debounce(() => saveAll("change"), 250);

async function saveAll(reason){
  // Always persist locally
  saveToLocalStorage();

  // Also try file/server if connected
  setStatus(state.saveInFlight ? "Сохранение…" : "Сохранено локально");
  const payload = serialize();

  // Prefer server if connected, otherwise file handle if available
  if (state.serverConnected){
    await saveViaServer(payload, reason);
    return;
  }

  if (state.fileHandle){
    await saveViaFileHandle(payload, reason);
    return;
  }

  state.lastSavedAt = new Date();
  setStatus("Сохранено локально");
}

async function saveViaServer(payload, reason){
  try{
    state.saveInFlight = true;
    setStatus("Сохранение в файл…");
    const res = await fetch("/api/save", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ text: payload, reason, updatedAt: nowISO() })
    });
    if (!res.ok) throw new Error("save failed");
    state.lastSavedAt = new Date();
    setStatus("Сохранено в tasks.txt");
  }catch(e){
    console.warn(e);
    setStatus("Ошибка автосейва (server). Осталось в localStorage.");
  }finally{
    state.saveInFlight = false;
  }
}

async function saveViaFileHandle(payload, reason){
  try{
    state.saveInFlight = true;
    setStatus("Сохранение в файл…");
    const writable = await state.fileHandle.createWritable();
    await writable.write(payload);
    await writable.close();
    state.lastSavedAt = new Date();
    setStatus("Сохранено в файл");
  }catch(e){
    console.warn(e);
    setStatus("Ошибка автосейва (file). Осталось в localStorage.");
  }finally{
    state.saveInFlight = false;
  }
}

async function connectServer(){
  try{
    setStatus("Проверка сервера…");
    const ping = await fetch("/api/ping");
    if (!ping.ok) throw new Error("no server");
    state.serverConnected = true;

    // Attempt load from server file
    const r = await fetch("/api/load");
    if (r.ok){
      const data = await r.json();
      if (typeof data?.text === "string" && data.text.trim()){
        const tasks = deserialize(data.text);
        if (tasks){
          state.tasks = tasks;
          saveToLocalStorage();
          render();
        }
      }
    }

    setStatus("Сервер подключен • автосейв в tasks.txt");
    debouncedSave();
  }catch(e){
    console.warn(e);
    state.serverConnected = false;
    setStatus("Сервер не найден. Запустите Node (см. README).");
  }
}

async function connectFile(){
  // File System Access API requires secure context (https/localhost) and supported browser.
  if (!("showSaveFilePicker" in window)){
    setStatus("File API не поддерживается. Используйте режим Node.");
    return;
  }
  try{
    const handle = await window.showSaveFilePicker({
      suggestedName: "tasks.txt",
      types: [{
        description: "Planner tasks (JSON text)",
        accept: {"text/plain": [".txt", ".json"]}
      }]
    });
    state.fileHandle = handle;
    state.serverConnected = false; // prefer one
    await saveAll("connect-file");
    setStatus("Файл подключен • автосейв");
  }catch(e){
    console.warn(e);
    setStatus("Файл не выбран.");
  }
}

function downloadText(filename, text){
  const blob = new Blob([text], {type:"text/plain;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}

function applyTheme(theme){
  state.theme = theme;
  $("#app").setAttribute("data-theme", theme);
  localStorage.setItem(UI_KEY, JSON.stringify({theme}));
}

function loadUI(){
  try{
    const raw = localStorage.getItem(UI_KEY);
    if (!raw) return;
    const ui = JSON.parse(raw);
    if (ui?.theme) applyTheme(ui.theme);
  }catch{}
}

function setDefaultTag(color){
  state.defaultTag = color;
  $$(".chip").forEach(b => b.classList.toggle("selected", b.dataset.color === color));
}

function matchesFilter(task){
  if (!state.filter) return true;
  const q = state.filter.trim().toLowerCase();
  return task.text.toLowerCase().includes(q);
}

function render(){
  const list = $("#tasks");
  const empty = $("#empty");
  list.innerHTML = "";

  const visible = state.tasks.filter(matchesFilter);
  if (visible.length === 0){
    empty.hidden = state.tasks.length !== 0; // show empty only when truly empty (no tasks)
    if (state.tasks.length === 0) empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const tpl = $("#taskTpl");
  for (const task of visible){
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = task.id;
    if (task.done) node.classList.add("done");

    const input = $(".text", node);
    input.value = task.text;

    const tag = $(".tag", node);
    tag.dataset.color = task.tag ?? "none";

    const time = $(".time", node);
    time.textContent = "создано: " + formatTime(task.createdAt);

    // Sync selected dot
    $$(".dot", node).forEach(d => d.classList.toggle("selected", d.dataset.color === (task.tag ?? "none")));

    // --- events
    const check = $(".check", node);
    check.addEventListener("click", () => {
      task.done = !task.done;
      task.updatedAt = nowISO();
      render();
      debouncedSave();
    });

    $(".del", node).addEventListener("click", () => {
      state.tasks = state.tasks.filter(t => t.id !== task.id);
      render();
      debouncedSave();
    });

    // Color tag
    $$(".dot", node).forEach(d => {
      d.addEventListener("click", () => {
        task.tag = d.dataset.color;
        task.updatedAt = nowISO();
        render();
        debouncedSave();
      });
    });

    // Inline edit commit on Enter or blur
    let original = task.text;
    input.addEventListener("focus", () => { original = task.text; });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter"){
        ev.preventDefault();
        input.blur();
      }
      if (ev.key === "Escape"){
        ev.preventDefault();
        input.value = original;
        input.blur();
      }
    });
    input.addEventListener("blur", () => {
      const val = input.value.trim();
      if (!val){
        // If emptied — delete
        state.tasks = state.tasks.filter(t => t.id !== task.id);
        render();
        debouncedSave();
        return;
      }
      if (val !== task.text){
        task.text = val;
        task.updatedAt = nowISO();
        render();
        debouncedSave();
      }
    });

    // Drag & drop
    wireDnD(node);

    list.appendChild(node);
  }
}

let draggingId = null;

function wireDnD(node){
  node.addEventListener("dragstart", (e) => {
    draggingId = node.dataset.id;
    node.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try{ e.dataTransfer.setData("text/plain", draggingId); }catch{}
  });

  node.addEventListener("dragend", () => {
    node.classList.remove("dragging");
    draggingId = null;
    // After drag DOM order already changed; rebuild state order
    syncOrderFromDOM();
  });

  node.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const list = $("#tasks");
    const after = getDragAfterElement(list, e.clientY);
    const dragging = $(".task.dragging");
    if (!dragging) return;
    if (after == null) list.appendChild(dragging);
    else list.insertBefore(dragging, after);
  });

  node.addEventListener("drop", (e) => {
    e.preventDefault();
  });
}

function getDragAfterElement(container, y){
  const els = [...container.querySelectorAll(".task:not(.dragging)")];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const el of els){
    const box = el.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset){
      closest = { offset, element: el };
    }
  }
  return closest.element;
}

function syncOrderFromDOM(){
  const ids = $$("#tasks .task").map(n => n.dataset.id);
  if (!ids.length) return;
  // Keep tasks not visible in filter at the end in original order:
  const map = new Map(state.tasks.map(t => [t.id, t]));
  const visibleOrdered = ids.map(id => map.get(id)).filter(Boolean);

  if (!state.filter){
    state.tasks = visibleOrdered;
  } else {
    // If filtering, reorder only those visible, keep others in place.
    const visibleSet = new Set(ids);
    const rest = state.tasks.filter(t => !visibleSet.has(t.id));
    state.tasks = [...visibleOrdered, ...rest];
  }
  debouncedSave();
}

function addTask(text){
  const t = {
    id: uid(),
    text: text.trim(),
    done: false,
    tag: state.defaultTag,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
  state.tasks.unshift(t);
  render();
  debouncedSave();
}

function clearDone(){
  state.tasks = state.tasks.filter(t => !t.done);
  render();
  debouncedSave();
}

function clearAll(){
  state.tasks = [];
  render();
  debouncedSave();
}

function debounce(fn, ms){
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// --- PiP (Document Picture-in-Picture) with fallback popout window
async function openPiP(){
  // Prefer Document PiP if available
  if ("documentPictureInPicture" in window){
    try{
      if (state.pip.window){
        // already open → close
        state.pip.window.close();
        return;
      }

      const pipWin = await window.documentPictureInPicture.requestWindow({ width: 420, height: 640 });
      state.pip.window = pipWin;

      // Copy styles
      const styleText = await (await fetch("./style.css")).text();
      const styleEl = pipWin.document.createElement("style");
      styleEl.textContent = styleText;
      pipWin.document.head.appendChild(styleEl);

      // Ensure base background
      pipWin.document.body.style.margin = "0";
      pipWin.document.body.style.background = getComputedStyle(document.body).backgroundColor;

      // Move the app root into PiP window (keeps full interactivity)
      const app = $("#app");
      state.pip.hostParent = app.parentElement;
      state.pip.hostNextSibling = app.nextSibling;

      pipWin.document.body.appendChild(app);

      // When PiP closed, move back
      pipWin.addEventListener("pagehide", () => {
        restoreFromPiP();
      });
      pipWin.addEventListener("unload", () => {
        restoreFromPiP();
      });

      setStatus("PiP открыт • окно поверх");
    }catch(e){
      console.warn(e);
      setStatus("Не удалось открыть PiP. Открою окно‑fallback…");
      openPopoutFallback();
    }
  } else {
    openPopoutFallback();
  }
}

function restoreFromPiP(){
  const app = $("#app");
  if (!state.pip.hostParent) return;
  if (state.pip.hostNextSibling) state.pip.hostParent.insertBefore(app, state.pip.hostNextSibling);
  else state.pip.hostParent.appendChild(app);
  state.pip.window = null;
  state.pip.hostParent = null;
  state.pip.hostNextSibling = null;
  setStatus("PiP закрыт");
}

function openPopoutFallback(){
  // Fallback: separate small window. Sync via localStorage "storage" events.
  const w = window.open("./popout.html", "planner_popout", "width=420,height=640");
  if (!w) setStatus("Попап заблокирован браузером.");
}

// --- wiring UI
function init(){
  loadUI();
  // Load tasks: try localStorage first.
  if (!loadFromLocalStorage()){
    state.tasks = [];
  }
  setDefaultTag("none");
  render();
  setStatus("Готово • локально сохранено");

  // Default tag picker
  $$(".chip").forEach(btn => {
    btn.addEventListener("click", () => setDefaultTag(btn.dataset.color));
  });

  // Add
  $("#addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#taskInput");
    const text = input.value;
    if (!text.trim()) return;
    addTask(text);
    input.value = "";
    input.focus();
  });

  // Search
  $("#searchInput").addEventListener("input", (e) => {
    state.filter = e.target.value;
    render();
  });

  // Clear done/all
  $("#btnClearDone").addEventListener("click", clearDone);
  $("#btnClearAll").addEventListener("click", clearAll);

  // Theme
  $("#btnTheme").addEventListener("click", () => {
    applyTheme(state.theme === "dark" ? "light" : "dark");
    // If in PiP and we moved DOM, body background might be stale; not critical.
  });

  // Help
  $("#btnHelp").addEventListener("click", () => {
    const h = $("#help");
    h.hidden = !h.hidden;
  });

  // Connects
  $("#btnConnectServer").addEventListener("click", connectServer);
  $("#btnConnectFile").addEventListener("click", connectFile);

  // Export / import
  $("#btnExport").addEventListener("click", () => {
    downloadText("tasks.txt", serialize());
  });
  $("#fileImport").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const tasks = deserialize(text);
    if (!tasks){
      setStatus("Импорт: не удалось распарсить JSON");
      return;
    }
    state.tasks = tasks;
    render();
    debouncedSave();
    setStatus("Импортировано");
    e.target.value = "";
  });

  // PiP
  $("#btnPip").addEventListener("click", openPiP);

  // Sync from other windows (popout fallback)
  window.addEventListener("storage", (ev) => {
    if (ev.key === STORAGE_KEY && typeof ev.newValue === "string"){
      const tasks = deserialize(ev.newValue);
      if (tasks){
        state.tasks = tasks;
        render();
        setStatus("Синхронизировано");
      }
    }
  });

  // If server is already running, auto connect quietly
  connectServer().catch(()=>{});
}

init();
