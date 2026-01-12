// Popout fallback window.
// Sync is via localStorage: any change writes STORAGE_KEY, the other window receives 'storage' event.

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];

const STORAGE_KEY = "planner.tasks.v1";
const UI_KEY = "planner.ui.v1";

const state = { tasks: [], theme: "dark", filter: "" };

function nowISO(){ return new Date().toISOString(); }
function uid(){ return (crypto?.randomUUID?.() ?? ("t_" + Math.random().toString(16).slice(2) + Date.now().toString(16))); }

function serialize(){
  return JSON.stringify({version:1, updatedAt: nowISO(), tasks: state.tasks}, null, 2);
}
function deserialize(text){
  try{
    const obj = JSON.parse(text);
    if (!obj || !Array.isArray(obj.tasks)) return [];
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

function setStatus(t){ $("#saveStatus").textContent = t; }

function save(){
  localStorage.setItem(STORAGE_KEY, serialize());
  setStatus("Сохранено (через localStorage)");
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

function matchesFilter(task){
  if (!state.filter) return true;
  return task.text.toLowerCase().includes(state.filter.trim().toLowerCase());
}

function render(){
  const list = $("#tasks");
  const empty = $("#empty");
  list.innerHTML = "";

  const visible = state.tasks.filter(matchesFilter);
  if (visible.length === 0){
    empty.hidden = state.tasks.length !== 0;
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
    time.textContent = "";

    $(".check", node).addEventListener("click", () => {
      task.done = !task.done;
      task.updatedAt = nowISO();
      render();
      save();
    });

    $(".del", node).addEventListener("click", () => {
      state.tasks = state.tasks.filter(t => t.id !== task.id);
      render();
      save();
    });

    let original = task.text;
    input.addEventListener("focus", () => { original = task.text; });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter"){ ev.preventDefault(); input.blur(); }
      if (ev.key === "Escape"){ ev.preventDefault(); input.value = original; input.blur(); }
    });
    input.addEventListener("blur", () => {
      const val = input.value.trim();
      if (!val){
        state.tasks = state.tasks.filter(t => t.id !== task.id);
        render(); save(); return;
      }
      if (val !== task.text){
        task.text = val;
        task.updatedAt = nowISO();
        render();
        save();
      }
    });

    // Drag reorder (same as main, simplified)
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
  });
  node.addEventListener("dragend", () => {
    node.classList.remove("dragging");
    draggingId = null;
    syncOrderFromDOM();
  });
  node.addEventListener("dragover", (e) => {
    e.preventDefault();
    const list = $("#tasks");
    const after = getDragAfterElement(list, e.clientY);
    const dragging = $(".task.dragging");
    if (!dragging) return;
    if (after == null) list.appendChild(dragging);
    else list.insertBefore(dragging, after);
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
  const map = new Map(state.tasks.map(t => [t.id, t]));
  state.tasks = ids.map(id => map.get(id)).filter(Boolean);
  save();
}

function addTask(text){
  state.tasks.unshift({ id: uid(), text: text.trim(), done:false, tag:"none", createdAt: nowISO(), updatedAt: nowISO() });
  render(); save();
}

function load(){
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  const tasks = deserialize(raw);
  if (tasks) state.tasks = tasks;
}

export function initPopout(){
  loadUI();
  load();
  render();
  setStatus("Окно готово • синхронизируется");

  $("#addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#taskInput");
    if (!input.value.trim()) return;
    addTask(input.value);
    input.value = "";
    input.focus();
  });

  $("#searchInput").addEventListener("input", (e) => {
    state.filter = e.target.value;
    render();
  });

  $("#btnTheme").addEventListener("click", () => {
    applyTheme(state.theme === "dark" ? "light" : "dark");
  });

  window.addEventListener("storage", (ev) => {
    if (ev.key === STORAGE_KEY && typeof ev.newValue === "string"){
      const tasks = deserialize(ev.newValue);
      if (tasks){
        state.tasks = tasks;
        render();
        setStatus("Синхронизировано");
      }
    }
    if (ev.key === UI_KEY && typeof ev.newValue === "string"){
      try{
        const ui = JSON.parse(ev.newValue);
        if (ui?.theme) applyTheme(ui.theme);
      }catch{}
    }
  });
}
