// Persanal Planer — задачи (перетаскивание, цвета, время, автосейв в файл).
// Сохранение:
// - tasks.txt через File System Access API (Chrome/Edge) — файл перезаписывается после каждого изменения.
// - Всегда есть fallback в localStorage.

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];

const STORAGE_KEY = "planner.tasks.v4";

const state = {
  tasks: [],
  defaultTag: "none",
  fileHandle: null,
  filter: "",
  saveInFlight: false,
  pip: { window: null, hostParent: null, hostNextSibling: null },
};

function nowISO(){ return new Date().toISOString(); }
function uid(){ return (crypto?.randomUUID?.() || String(Date.now()) + "-" + Math.random().toString(16).slice(2)); }

/* ---------- Serialization ---------- */

function serializeTasks(){
  return JSON.stringify({ version: 4, updatedAt: nowISO(), tasks: state.tasks }, null, 2);
}

function deserialize(text){
  try{
    const obj = JSON.parse(text);
    const tasks = obj?.tasks;
    if (!Array.isArray(tasks)) return null;
    return tasks
      .filter(t => typeof t?.id === "string" && typeof t?.text === "string")
      .map(t => ({
        id: t.id,
        text: String(t.text).slice(0, 600),
        done: !!t.done,
        tag: ["none","blue","yellow","red","purple","green"].includes(t.tag) ? t.tag : "none",
        hours: Number.isFinite(+t.hours) ? Math.max(0, +t.hours) : 0,
        createdAt: t.createdAt || nowISO(),
        updatedAt: t.updatedAt || nowISO(),
      }));
  }catch{
    return null;
  }
}

function saveToLocalStorage(){
  try{ localStorage.setItem(STORAGE_KEY, serializeTasks()); }catch{}
}

function loadFromLocalStorage(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return deserialize(raw);
  }catch{
    return null;
  }
}

function setStatus(msg){
  const el = $("#saveStatus");
  if (el) el.textContent = msg;
}

/* ---------- IndexedDB for remembering file handle ---------- */

const DB_NAME = "planner-db";
const DB_STORE = "kv";
const DB_KEY_HANDLE = "fileHandle";

function idbOpen(){
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("indexedDB not supported"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key){
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value){
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

/* ---------- File connect / autosave ---------- */

async function ensureReadWritePermission(handle){
  try{
    const q = await handle.queryPermission?.({ mode: "readwrite" });
    if (q === "granted") return true;
    const r = await handle.requestPermission?.({ mode: "readwrite" });
    return r === "granted";
  }catch{
    return false;
  }
}

async function loadTasksFromFileHandle(handle){
  try{
    const file = await handle.getFile();
    const text = await file.text();
    if (text && text.trim()){
      const tasks = deserialize(text);
      if (tasks){
        state.tasks = tasks;
        saveToLocalStorage();
        renderAll();
      }
    }
  }catch(e){
    console.warn(e);
  }
}

async function tryRestoreFileHandle(){
  if (!("showOpenFilePicker" in window) && !("showSaveFilePicker" in window)) return false;
  try{
    const handle = await idbGet(DB_KEY_HANDLE);
    if (!handle) return false;

    const ok = await ensureReadWritePermission(handle);
    if (!ok){
      setStatus("Сохранено в localStorage • подключите tasks.txt для автосейва");
      return false;
    }

    state.fileHandle = handle;
    await loadTasksFromFileHandle(handle);
    setStatus("Файл подключен • автосейв активен");
    return true;
  }catch(e){
    console.warn(e);
    return false;
  }
}

async function connectFile(){
  const canOpen = "showOpenFilePicker" in window;
  const canSave = "showSaveFilePicker" in window;
  if (!canOpen && !canSave){
    setStatus("Автосейв в файл недоступен в этом браузере. Используется localStorage.");
    return;
  }

  try{
    let handle = null;
    if (canOpen){
      const [picked] = await window.showOpenFilePicker({
        multiple: false,
        types: [{
          description: "Tasks (JSON text)",
          accept: {"text/plain": [".txt", ".json"], "application/json": [".json"]}
        }]
      });
      handle = picked;
    }else{
      handle = await window.showSaveFilePicker({
        suggestedName: "tasks.txt",
        types: [{
          description: "Tasks (JSON text)",
          accept: {"text/plain": [".txt", ".json"], "application/json": [".json"]}
        }]
      });
    }

    const ok = await ensureReadWritePermission(handle);
    if (!ok){
      setStatus("Нет прав на запись в файл.");
      return;
    }

    state.fileHandle = handle;
    await idbSet(DB_KEY_HANDLE, handle);

    await loadTasksFromFileHandle(handle);
    await saveAll("connect-file");
    setStatus("Файл подключен • автосейв активен");
  }catch(e){
    console.warn(e);
    setStatus("Файл не выбран.");
  }
}

async function saveViaFileHandle(payload){
  try{
    state.saveInFlight = true;
    setStatus("Сохранение…");
    const writable = await state.fileHandle.createWritable();
    await writable.write(payload);
    await writable.close();
    setStatus("Сохранено в tasks.txt");
  }catch(e){
    console.warn(e);
    setStatus("Ошибка записи в файл • сохранено в localStorage");
  }finally{
    state.saveInFlight = false;
  }
}

let saveTimer = null;
function debouncedSave(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveAll("debounce"), 180);
}

async function saveAll(reason){
  const payload = serializeTasks();
  saveToLocalStorage();
  if (state.fileHandle){
    await saveViaFileHandle(payload, reason);
  }else{
    setStatus("Сохранено в localStorage • подключите tasks.txt для автосейва");
  }
}

/* ---------- CRUD ---------- */

function addTask(text){
  const t = text.trim();
  if (!t) return;
  state.tasks.unshift({
    id: uid(),
    text: t.slice(0,600),
    done: false,
    tag: state.defaultTag,
    hours: 0,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  });
  renderAll();
  debouncedSave();
}

function toggleDone(id){
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  t.done = !t.done;
  t.updatedAt = nowISO();
  renderTaskById(id);
  debouncedSave();
}

function setTaskTag(id, tag){
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  t.tag = tag;
  t.updatedAt = nowISO();
  renderTaskById(id);
  debouncedSave();
}

function updateText(id, text){
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  const v = (text || "").trim().replace(/\s+/g, " ").slice(0,600);
  if (!v) return;
  t.text = v;
  t.updatedAt = nowISO();
  debouncedSave();
}

function setTaskHours(id, hours){
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  const v = Number.isFinite(+hours) ? Math.max(0, +hours) : 0;
  t.hours = v;
  t.updatedAt = nowISO();
  renderTotal();
  debouncedSave();
}

function removeTask(id){
  state.tasks = state.tasks.filter(t => t.id !== id);
  renderAll();
  debouncedSave();
}

function clearAll(){
  state.tasks = [];
  renderAll();
  debouncedSave();
}

function clearDone(){
  const before = state.tasks.length;
  state.tasks = state.tasks.filter(t => !t.done);
  if (state.tasks.length !== before){
    renderAll();
    debouncedSave();
  }
}

/* ---------- Filter & totals ---------- */

function matchesFilter(t){ return true; }

function renderTotal(){
  const total = state.tasks.reduce((s, t) => s + (Number.isFinite(+t.hours) ? +t.hours : 0), 0);
  const el = $("#totalTime");
  if (el){
    const rounded = Math.round(total * 100) / 100;
    el.textContent = `${rounded} ч`;
  }
}

/* ---------- Palette UI ---------- */

function closeAllPalettes(exceptTask=null){
  $$(".task.show-palette").forEach(t => { if (t !== exceptTask) t.classList.remove("show-palette"); });
}


/* ---------- Rendering ---------- */

function createTaskNode(t){
  const tpl = $("#tplTask");
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = t.id;
  node.classList.toggle("done", !!t.done);
  node.classList.add("tag-" + (t.tag || "none"));

  $(".drag", node).addEventListener("pointerdown", (e) => startPointerDrag(e, node));

  $(".check", node).addEventListener("click", () => toggleDone(t.id));

  const textEl = $(".text", node);
  textEl.textContent = t.text;
  textEl.setAttribute("contenteditable", "true");
  textEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter"){
      e.preventDefault();
      textEl.blur();
    }
  });
  textEl.addEventListener("blur", () => updateText(t.id, textEl.textContent));

  // Color bar + palette
  const palette = $(".palette", node);
  const bar = $(".colorbar", node);
  // palette hidden by default; show only on click
  bar.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = node.classList.contains("show-palette");
    closeAllPalettes(node);
    node.classList.toggle("show-palette", !isOpen);
  });

  $$(".pcolor", palette).forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setTaskTag(t.id, btn.dataset.color);
      node.classList.remove("show-palette");
    });
  });

  document.addEventListener("click", () => { palette.hidden = true; }, { once: true });

  // Time
  const timeInput = $(".time", node);
  timeInput.value = t.hours ? String(t.hours) : "";
  timeInput.addEventListener("change", () => setTaskHours(t.id, timeInput.value));
  timeInput.addEventListener("blur", () => setTaskHours(t.id, timeInput.value));

  $(".del", node).addEventListener("click", () => removeTask(t.id));

  return node;
}

function renderAll(){
  const list = $("#tasks");
  const empty = $("#empty");
  list.innerHTML = "";

  const tasks = state.tasks.filter(matchesFilter);
  if (empty) empty.hidden = true;

  for (const t of tasks){
    list.appendChild(createTaskNode(t));
  }
  renderTotal();
}

function renderTaskById(id){
  const node = $(`.task[data-id="${CSS.escape(id)}"]`);
  const t = state.tasks.find(x => x.id === id);
  if (!node || !t){
    renderAll();
    return;
  }
  node.classList.toggle("done", !!t.done);
  node.classList.remove("tag-none","tag-blue","tag-yellow","tag-red","tag-purple","tag-green");
  node.classList.add("tag-" + (t.tag || "none"));

  const timeInput = $(".time", node);
  if (document.activeElement !== timeInput){
    timeInput.value = t.hours ? String(t.hours) : "";
  }
  renderTotal();
}

/* ---------- Pointer drag reorder + animation ---------- */

let dragState = null;

function getTaskElements(){
  return $$("#tasks .task");
}

function measurePositions(){
  const map = new Map();
  for (const el of getTaskElements()){
    if (el.style.display === "none") continue;
    map.set(el.dataset.id, el.getBoundingClientRect());
  }
  return map;
}

function animateFLIP(firstMap){
  const lastEls = getTaskElements();
  for (const el of lastEls){
    if (el.style.display === "none") continue;
    const id = el.dataset.id;
    const first = firstMap.get(id);
    if (!first) continue;
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;

    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0,0)" }],
      { duration: 220, easing: "cubic-bezier(0.2,0,0,1)" }
    );
  }
}

function findInsertBefore(container, y){
  const items = [...container.querySelectorAll(".task")].filter(el => el.style.display !== "none");
  for (const el of items){
    const rect = el.getBoundingClientRect();
    if (y < rect.top + rect.height/2) return el;
  }
  return null;
}

function startPointerDrag(e, taskEl){
  e.preventDefault();
  e.stopPropagation();
  closeAllPalettes();

  const list = $("#tasks");
  const id = taskEl.dataset.id;

  taskEl.setPointerCapture?.(e.pointerId);

  const rect = taskEl.getBoundingClientRect();
  const offsetX = e.clientX - rect.left;
  const offsetY = e.clientY - rect.top;

  const ghost = taskEl.cloneNode(true);
  ghost.classList.add("drag-ghost");
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
  ghost.style.boxShadow = "0 12px 36px rgba(0,0,0,0.55)";
  document.body.appendChild(ghost);

  const placeholder = document.createElement("div");
  placeholder.className = "placeholder";
  placeholder.style.height = `${rect.height}px`;

  const first = measurePositions();
  list.insertBefore(placeholder, taskEl.nextSibling);
  taskEl.classList.add("dragging");
  taskEl.style.display = "none";
  animateFLIP(first);

  dragState = { id, taskEl, ghost, placeholder, offsetX, offsetY, pointerId: e.pointerId };

  const onMove = (ev) => pointerMove(ev);
  const onUp = (ev) => pointerUp(ev);

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
  window.addEventListener("pointercancel", onUp, { once: true });

  dragState.cleanup = () => window.removeEventListener("pointermove", onMove);
}

function pointerMove(e){
  if (!dragState || e.pointerId !== dragState.pointerId) return;

  const x = e.clientX - dragState.offsetX;
  const y = e.clientY - dragState.offsetY;
  dragState.ghost.style.transform = `translate(${x}px, ${y}px)`;

  const list = $("#tasks");
  const beforeEl = findInsertBefore(list, e.clientY);

  const first = measurePositions();
  if (beforeEl){
    if (beforeEl !== dragState.placeholder.nextSibling){
      list.insertBefore(dragState.placeholder, beforeEl);
      animateFLIP(first);
    }
  }else{
    if (dragState.placeholder !== list.lastElementChild){
      list.appendChild(dragState.placeholder);
      animateFLIP(first);
    }
  }
}

async function pointerUp(e){
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  dragState.cleanup?.();

  const list = $("#tasks");

  // Where should it land?
  const targetRect = dragState.placeholder.getBoundingClientRect();

  // Animate ghost into place (prevents "teleport from corner")
  const current = dragState.ghost.getBoundingClientRect();
  const dx = targetRect.left - current.left;
  const dy = targetRect.top - current.top;

  const ghostAnim = dragState.ghost.animate(
    [
      { transform: dragState.ghost.style.transform },
      { transform: `translate(${current.left + dx}px, ${current.top + dy}px)` }
    ],
    { duration: 160, easing: "cubic-bezier(0.2,0,0,1)" }
  );

  // Update layout behind ghost (with FLIP for neighbors)
  const first = measurePositions();
  dragState.taskEl.style.display = "";
  dragState.taskEl.classList.remove("dragging");
  list.insertBefore(dragState.taskEl, dragState.placeholder);
  dragState.placeholder.remove();
  animateFLIP(first);

  // Wait and clean
  try{ await ghostAnim.finished; }catch{}
  dragState.ghost.remove();

  // Update state order from DOM
  const ids = [...list.querySelectorAll(".task")].map(el => el.dataset.id);
  const map = new Map(state.tasks.map(t => [t.id, t]));
  state.tasks = ids.map(id => map.get(id)).filter(Boolean);

  renderTotal();
  debouncedSave();
  dragState = null;
}

/* ---------- Help & PiP ---------- */

function toggleHelp(){
  const h = $("#help");
  h.hidden = !h.hidden;
}

async function openPiP(){
  if ("documentPictureInPicture" in window){
    try{
      if (state.pip.window && !state.pip.window.closed){
        state.pip.window.close();
        return;
      }

      const pipWin = await window.documentPictureInPicture.requestWindow({ width: 460, height: 680 });
      const app = $("#app");
      state.pip.hostParent = app.parentElement;
      state.pip.hostNextSibling = app.nextSibling;

      pipWin.document.body.style.margin = "0";
      pipWin.document.body.style.background = getComputedStyle(document.body).backgroundColor;

      for (const ss of document.styleSheets){
        try{
          const rules = ss.cssRules;
          const style = pipWin.document.createElement("style");
          style.textContent = [...rules].map(r => r.cssText).join("\n");
          pipWin.document.head.appendChild(style);
        }catch{
          if (ss.href){
            const link = pipWin.document.createElement("link");
            link.rel = "stylesheet";
            link.href = ss.href;
            pipWin.document.head.appendChild(link);
          }
        }
      }

      pipWin.document.body.appendChild(app);
      state.pip.window = pipWin;

      pipWin.addEventListener("pagehide", () => {
        if (state.pip.hostParent){
          if (state.pip.hostNextSibling){
            state.pip.hostParent.insertBefore(app, state.pip.hostNextSibling);
          }else{
            state.pip.hostParent.appendChild(app);
          }
        }
        state.pip.window = null;
      }, { once: true });

      return;
    }catch(e){
      console.warn(e);
    }
  }

  const w = window.open("./popout.html", "plannerPopout", "width=460,height=680");
  if (!w) setStatus("Окно заблокировано браузером.");
}

/* ---------- Textarea autosize ---------- */

function autosizeTextarea(el){
  if (!el) return;
  el.style.height = "0px";
  const h = Math.max(46, el.scrollHeight);
  el.style.height = h + "px";
}

/* ---------- Init ---------- */

async function init(){
  state.tasks = loadFromLocalStorage() || [];
  renderAll();

  const restored = await tryRestoreFileHandle();
  if (!restored) setStatus("Сохранено в localStorage • подключите tasks.txt для автосейва");

  const input = $("#taskInput");
  autosizeTextarea(input);
  input.addEventListener("input", () => autosizeTextarea(input));

  $("#addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    addTask(input.value);
    input.value = "";
    autosizeTextarea(input);
    input.focus();
  });

  $$(".chip").forEach(btn => {
    btn.addEventListener("click", () => {
      state.defaultTag = btn.dataset.color;
      $$(".chip").forEach(b => b.classList.toggle("active", b === btn));
    });
  });
  const initChip = $(`.chip[data-color="${state.defaultTag}"]`);
  if (initChip) initChip.classList.add("active");

  $("#btnClearDone").addEventListener("click", clearDone);
  $("#btnClearAll").addEventListener("click", clearAll);
  $("#btnHelp").addEventListener("click", toggleHelp);
  $("#btnPip").addEventListener("click", openPiP);
  $("#btnConnectFile").addEventListener("click", connectFile);

  document.addEventListener("click", () => closeAllPalettes());
}


init();
