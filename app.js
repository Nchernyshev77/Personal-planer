// Planner — минималистичный трекер задач с перетаскиванием и автосейвом в файл (Chrome/Edge).
// Сохранение:
// - Если подключен tasks.txt через File System Access API: перезаписывает файл после каждого изменения.
// - Всегда есть fallback в localStorage (на случай отсутствия поддержки/прав).

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];

const STORAGE_KEY = "planner.tasks.v1";

/** @type {{tasks: any[], defaultTag: string, fileHandle: any|null, lastSavedAt: Date|null, saveInFlight: boolean, pip: any, filter: string}} */
const state = {
  tasks: [],
  defaultTag: "none",
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
function uid(){ return (crypto?.randomUUID?.() || String(Date.now()) + "-" + Math.random().toString(16).slice(2)); }

function serializeTasks(){
  return JSON.stringify({ version: 1, updatedAt: nowISO(), tasks: state.tasks }, null, 2);
}

function deserialize(text){
  try{
    const obj = JSON.parse(text);
    const tasks = obj?.tasks;
    if (!Array.isArray(tasks)) return null;
    // basic shape
    return tasks
      .filter(t => typeof t?.id === "string" && typeof t?.text === "string")
      .map(t => ({
        id: t.id,
        text: String(t.text).slice(0, 200),
        done: !!t.done,
        tag: ["none","blue","yellow","red","purple"].includes(t.tag) ? t.tag : "none",
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
  if (!el) return;
  el.textContent = msg;
}

/* ---------- IndexedDB for remembering the file handle ---------- */

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

/* ---------- File handle connect / restore ---------- */

async function loadTasksFromFileHandle(handle){
  try{
    const file = await handle.getFile();
    const text = await file.text();
    if (text && text.trim()){
      const tasks = deserialize(text);
      if (tasks){
        state.tasks = tasks;
        saveToLocalStorage();
        render();
      }
    }
  }catch(e){
    console.warn(e);
  }
}

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

async function tryRestoreFileHandle(){
  // Only works in browsers that support FS Access and IndexedDB structured cloning.
  if (!("showOpenFilePicker" in window) && !("showSaveFilePicker" in window)) return false;

  try{
    const handle = await idbGet(DB_KEY_HANDLE);
    if (!handle) return false;

    const ok = await ensureReadWritePermission(handle);
    if (!ok){
      setStatus("Нет доступа к tasks.txt • нажмите «Подключить tasks.txt»");
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
  // FS Access API requires secure context (https/localhost) and supported browser.
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
          description: "Planner tasks (JSON text)",
          accept: {"text/plain": [".txt", ".json"], "application/json": [".json"]}
        }]
      });
      handle = picked;
    }else{
      // fallback: create/choose via save picker
      handle = await window.showSaveFilePicker({
        suggestedName: "tasks.txt",
        types: [{
          description: "Planner tasks (JSON text)",
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

    // Make sure file exists & saved immediately
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
    state.lastSavedAt = new Date();
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

  // Always keep local fallback
  saveToLocalStorage();

  if (state.fileHandle){
    await saveViaFileHandle(payload, reason);
  }else{
    // keep status lightweight
    setStatus("Сохранено в localStorage • подключите tasks.txt для автосейва");
  }
}

/* ---------- Tasks CRUD ---------- */

function addTask(text){
  const t = text.trim();
  if (!t) return;
  state.tasks.unshift({
    id: uid(),
    text: t,
    done: false,
    tag: state.defaultTag,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  });
  render();
  debouncedSave();
}

function toggleDone(id){
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  t.done = !t.done;
  t.updatedAt = nowISO();
  render();
  debouncedSave();
}

function setTaskTag(id, tag){
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  t.tag = tag;
  t.updatedAt = nowISO();
  render();
  debouncedSave();
}

function updateText(id, text){
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  const v = text.trim().slice(0,200);
  if (!v) return;
  t.text = v;
  t.updatedAt = nowISO();
  render();
  debouncedSave();
}

function removeTask(id){
  state.tasks = state.tasks.filter(t => t.id !== id);
  render();
  debouncedSave();
}

function clearDone(){
  const before = state.tasks.length;
  state.tasks = state.tasks.filter(t => !t.done);
  if (state.tasks.length !== before){
    render();
    debouncedSave();
  }
}

function clearAll(){
  state.tasks = [];
  render();
  debouncedSave();
}

/* ---------- Drag & Drop reorder ---------- */

let dragId = null;

function onDragStart(e){
  const item = e.target.closest(".task");
  if (!item) return;
  dragId = item.dataset.id;
  item.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", dragId);
}

function onDragEnd(e){
  const item = e.target.closest(".task");
  if (item) item.classList.remove("dragging");
  dragId = null;
}

function onDragOver(e){
  e.preventDefault();
  const over = e.target.closest(".task");
  if (!over || !dragId) return;
  const overId = over.dataset.id;
  if (overId === dragId) return;

  const rect = over.getBoundingClientRect();
  const before = (e.clientY - rect.top) < rect.height / 2;

  const dragIndex = state.tasks.findIndex(t => t.id === dragId);
  const overIndex = state.tasks.findIndex(t => t.id === overId);
  if (dragIndex < 0 || overIndex < 0) return;

  const [moved] = state.tasks.splice(dragIndex, 1);
  const insertAt = before ? overIndex : overIndex + 1;
  state.tasks.splice(insertAt > dragIndex ? insertAt - 1 : insertAt, 0, moved);

  render();
  debouncedSave();
}

/* ---------- Rendering ---------- */

function matchesFilter(t){
  const q = state.filter.trim().toLowerCase();
  if (!q) return true;
  return t.text.toLowerCase().includes(q);
}

function render(){
  const list = $("#tasks");
  const empty = $("#empty");
  list.innerHTML = "";

  const tasks = state.tasks.filter(matchesFilter);
  empty.hidden = tasks.length !== 0;

  const tpl = $("#tplTask");
  for (const t of tasks){
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = t.id;
    if (t.done) node.classList.add("done");
    node.classList.add("tag-" + t.tag);

    const textEl = $(".text", node);
    textEl.textContent = t.text;

    const dot = $(".dot", node);
    dot.dataset.color = t.tag;

    // Dragging: only when grabbing handle, but HTML5 drag needs draggable element.
    node.addEventListener("dragstart", onDragStart);
    node.addEventListener("dragend", onDragEnd);

    $(".drag", node).addEventListener("pointerdown", () => {
      node.setAttribute("draggable", "true");
    });
    $(".drag", node).addEventListener("pointerup", () => {
      node.setAttribute("draggable", "true");
    });

    // Done
    $(".check", node).addEventListener("click", () => toggleDone(t.id));

    // Edit inline
    textEl.addEventListener("click", () => startEdit(textEl, t.id));
    textEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter"){ e.preventDefault(); startEdit(textEl, t.id); }
    });

    // Tag menu
    const tagBtn = $(".tag", node);
    const menu = $(".tag-menu", node);
    const delBtn = $(".del", node);

    tagBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });

    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeTask(t.id);
    });

    $$(".dot", menu).forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const c = btn.dataset.color;
        setTaskTag(t.id, c);
        menu.hidden = true;
      });
    });

    // Close menus on outside click
    document.addEventListener("click", () => { menu.hidden = true; }, { once: true });

    list.appendChild(node);
  }

}

function startEdit(textEl, id){
  const current = textEl.textContent;
  const input = document.createElement("input");
  input.className = "edit";
  input.value = current;
  input.maxLength = 200;

  const finish = () => {
    // restore original element
    if (input.isConnected) input.replaceWith(textEl);
  };

  const commit = () => {
    const v = input.value.trim().slice(0,200);
    if (v){
      updateText(id, v);
      textEl.textContent = v;
    }
    finish();
  };

  const cancel = () => {
    finish();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter"){ e.preventDefault(); commit(); }
    if (e.key === "Escape"){ e.preventDefault(); cancel(); }
  });

  input.addEventListener("blur", () => commit(), { once: true });

  textEl.replaceWith(input);
  input.focus();
  input.select();
}

/* ---------- Help toggle ---------- */

function toggleHelp(){
  const h = $("#help");
  h.hidden = !h.hidden;
}

/* ---------- PiP ---------- */

async function openPiP(){
  // Document Picture-in-Picture (Chrome)
  if ("documentPictureInPicture" in window){
    try{
      if (state.pip.window && !state.pip.window.closed){
        state.pip.window.close();
        return;
      }

      const pipWin = await window.documentPictureInPicture.requestWindow({
        width: 420,
        height: 620,
      });

      // Move app root into PiP
      const app = $("#app");
      state.pip.hostParent = app.parentElement;
      state.pip.hostNextSibling = app.nextSibling;

      pipWin.document.body.style.margin = "0";
      pipWin.document.body.style.background = getComputedStyle(document.body).backgroundColor;
      // Copy stylesheets
      for (const ss of document.styleSheets){
        try{
          const rules = ss.cssRules;
          const style = pipWin.document.createElement("style");
          style.textContent = [...rules].map(r => r.cssText).join("\n");
          pipWin.document.head.appendChild(style);
        }catch{
          // cross-origin stylesheets can't be read; fallback by linking
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
        // Restore DOM
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

  // Fallback: separate window (popout)
  const w = window.open("./popout.html", "plannerPopout", "width=420,height=620");
  if (!w) setStatus("Окно заблокировано браузером.");
}

/* ---------- Cross-window sync (fallback) ---------- */

function broadcast(){
  // For popout sync: keep localStorage as source of truth
  saveToLocalStorage();
  try{ localStorage.setItem("__planner_ping__", String(Date.now())); }catch{}
}

window.addEventListener("storage", (e) => {
  if (e.key === STORAGE_KEY || e.key === "__planner_ping__"){
    const tasks = loadFromLocalStorage();
    if (tasks){
      state.tasks = tasks;
      render();
    }
  }
});

/* ---------- Init ---------- */

async function init(){
  // Load tasks (local fallback first)
  const tasks = loadFromLocalStorage();
  if (tasks){
    state.tasks = tasks;
  }else{
    state.tasks = [];
  }

  render();

  // Drag & drop over container
  $('#tasks').addEventListener('dragover', onDragOver);

  // Try to restore file access and load from file if permitted
  const restored = await tryRestoreFileHandle();
  if (!restored){
    setStatus("Сохранено в localStorage • подключите tasks.txt для автосейва");
  }

  // Wire UI
  $("#addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#taskInput");
    addTask(input.value);
    input.value = "";
    input.focus();
    broadcast();
  });

  // Default tag chips
  $$(".chip").forEach(btn => {
    btn.addEventListener("click", () => {
      const color = btn.dataset.color;
      state.defaultTag = color;
      $$(".chip").forEach(b => b.classList.toggle("active", b === btn));
    });
  });
  // set initial active
  const initChip = $(`.chip[data-color="${state.defaultTag}"]`);
  if (initChip) initChip.classList.add("active");

  $("#searchInput").addEventListener("input", (e) => {
    state.filter = e.target.value;
    render();
  });

  $("#btnClearDone").addEventListener("click", () => { clearDone(); broadcast(); });
  $("#btnClearAll").addEventListener("click", () => { clearAll(); broadcast(); });

  $("#btnHelp").addEventListener("click", toggleHelp);
  $("#btnPip").addEventListener("click", openPiP);

  $("#btnConnectFile").addEventListener("click", async () => {
    await connectFile();
    broadcast();
  });

}

// Patch debouncedSave calls to also broadcast
const _debouncedSave = debouncedSave;
debouncedSave = function(){
  _debouncedSave();
  broadcast();
};

init();
