// ---------- настройки (держите в синхроне с client_bot.py) ----------
const DELIVERY_PRICE_PER_WEEK = 500;
const PICKUP_PRICE_PER_WEEK = 250;
const PICKUP_ADDRESS = "Москва, м. Тушинская";
const PICKUP_NOTE_EXTRA =
  "Требует дополнительного согласования даты и точного времени. Контакты для обсуждения: Мария, тел. +7 (977) 868-55-19 (Telegram, Max), email: sazhentsy.msk@mail.ru";
const CATALOG_URL = "catalog.json";

// ---------- telegram webapp init ----------
const tg = window.Telegram ? window.Telegram.WebApp : null;
if (tg) {
  tg.ready();
  tg.expand();
}

// ---------- state ----------
let CATALOG = [];
let CATEGORIES = [];
let ARTICLE_TO_ITEM = {};
let cart = {}; // { article: qty }
let activeCategory = "__all__";
let searchQuery = "";
let sortMode = "default"; // "default" | "price_asc" | "price_desc" | "week_asc"
let currentItemArticle = null;
let deliveryMethod = null; // "delivery" | "pickup" | null — пока не выбрано, доставка не считается
let screenStack = ["catalog"];

// ---------- helpers ----------
function fmtMoney(n) {
  return Math.round(n).toLocaleString("ru-RU");
}
function unitPrice(item) {
  return item.p / 10;
}
function weekLabel(item) {
  return item.w ? `неделя ${item.w}` : "неделя уточняется";
}

// Обработка ошибок загрузки фото
function handleImgError(img, article) {
  img.onerror = null; // Предотвращаем бесконечный цикл
  img.replaceWith(placeholderEl());
}

function computeTotals(method) {
  const lines = [];
  let itemsTotal = 0;
  const weeks = new Set();
  for (const articleStr in cart) {
    const article = Number(articleStr);
    const qty = cart[articleStr];
    const item = ARTICLE_TO_ITEM[article];
    if (!item) continue;
    const lineTotal = unitPrice(item) * qty;
    itemsTotal += lineTotal;
    if (item.w) weeks.add(item.w);
    lines.push({ item, qty, lineTotal });
  }
  let deliveryTotal = 0;
  if (method) {
    const pricePerWeek = method === "pickup" ? PICKUP_PRICE_PER_WEEK : DELIVERY_PRICE_PER_WEEK;
    deliveryTotal = weeks.size * pricePerWeek;
  }
  return { lines, itemsTotal, deliveryTotal, grandTotal: itemsTotal + deliveryTotal };
}

function cartCount() {
  return Object.values(cart).reduce((a, b) => a + b, 0);
}

// ---------- screen navigation ----------
function showScreen(name) {
  document.querySelectorAll(".screen").forEach((el) => (el.hidden = true));
  document.getElementById("screen-" + name).hidden = false;
  updateCartBar();
  updateTelegramButtons(name);
}

function pushScreen(name) {
  screenStack.push(name);
  showScreen(name);
}

function popScreen() {
  if (screenStack.length > 1) screenStack.pop();
  showScreen(screenStack[screenStack.length - 1]);
}

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => {
    screenStack = [btn.dataset.back];
    showScreen(btn.dataset.back);
  });
});

function updateTelegramButtons(screenName) {
  if (!tg) return;
  if (screenName === "catalog") {
    tg.BackButton.hide();
    tg.MainButton.hide();
  } else if (screenName === "item") {
    tg.BackButton.show();
    const item = ARTICLE_TO_ITEM[currentItemArticle];
    const qty = Number(document.getElementById("qty-value").textContent);
    tg.MainButton.setText(`Добавить в корзину — ${fmtMoney(unitPrice(item) * qty)} ₽`);
    tg.MainButton.show();
  } else if (screenName === "cart") {
    tg.BackButton.show();
    if (cartCount() > 0) {
      tg.MainButton.setText("Оформить заказ");
      tg.MainButton.show();
    } else {
      tg.MainButton.hide();
    }
  } else if (screenName === "checkout") {
    tg.BackButton.show();
    tg.MainButton.setText("Подтвердить заказ");
    tg.MainButton.show();
  }
}

if (tg) {
  tg.BackButton.onClick(() => popScreen());
  tg.MainButton.onClick(() => onMainButtonClick());
}

function onMainButtonClick() {
  const screenName = screenStack[screenStack.length - 1];
  if (screenName === "item") {
    addCurrentItemToCart();
  } else if (screenName === "cart") {
    openCheckout();
  } else if (screenName === "checkout") {
    submitOrder();
  }
}

// ---------- catalog rendering ----------
let categoryObserver = null;
let suppressObserverUntil = 0;

function renderCategories() {
  const wrap = document.getElementById("category-tabs");
  wrap.innerHTML = "";
  const all = document.createElement("button");
  all.className = "cat-pill" + (activeCategory === "__all__" ? " active" : "");
  all.dataset.cat = "__all__";
  all.textContent = "Все";
  all.onclick = () => scrollToCategory("__all__");
  wrap.appendChild(all);

  CATEGORIES.forEach((cat) => {
    const pill = document.createElement("button");
    pill.className = "cat-pill" + (activeCategory === cat ? " active" : "");
    pill.dataset.cat = cat;
    pill.textContent = cat;
    pill.onclick = () => scrollToCategory(cat);
    wrap.appendChild(pill);
  });
}

function setActivePill(cat) {
  activeCategory = cat;
  document.querySelectorAll("#category-tabs .cat-pill").forEach((p) => {
    p.classList.toggle("active", p.dataset.cat === cat);
  });
}

function scrollToCategory(cat) {
  const grid = document.getElementById("grid");
  suppressObserverUntil = Date.now() + 700;
  if (cat === "__all__") {
    setActivePill("__all__");
    grid.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const section = grid.querySelector(`.catalog-section[data-cat="${cssEscape(cat)}"]`);
  if (section) {
    setActivePill(cat);
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function cssEscape(str) {
  return window.CSS && CSS.escape ? CSS.escape(str) : str.replace(/["\\]/g, "\\$&");
}

function sortItems(items) {
  if (sortMode === "price_asc") {
    return [...items].sort((a, b) => unitPrice(a) - unitPrice(b));
  }
  if (sortMode === "price_desc") {
    return [...items].sort((a, b) => unitPrice(b) - unitPrice(a));
  }
  if (sortMode === "week_asc") {
    return [...items].sort((a, b) => {
      const aw = a.w ?? Infinity;
      const bw = b.w ?? Infinity;
      return aw - bw;
    });
  }
  return items;
}

function itemsForCategory(cat) {
  const q = searchQuery.trim().toLowerCase();
  const filtered = CATALOG.filter((item) => {
    const matchesCategory = item.c === cat;
    const matchesSearch = !q || item.v.toLowerCase().includes(q);
    return matchesCategory && matchesSearch;
  });
  return sortItems(filtered);
}

function renderGrid() {
  const grid = document.getElementById("grid");
  const empty = document.getElementById("empty-state");
  if (categoryObserver) {
    categoryObserver.disconnect();
    categoryObserver = null;
  }
  grid.innerHTML = "";

  const sections = CATEGORIES.map((cat) => ({ cat, items: itemsForCategory(cat) })).filter(
    (s) => s.items.length > 0
  );

  if (sections.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  sections.forEach(({ cat, items }) => {
    const section = document.createElement("div");
    section.className = "catalog-section";
    section.dataset.cat = cat;

    const header = document.createElement("div");
    header.className = "catalog-section-header";
    header.textContent = cat;
    section.appendChild(header);

    const cardsWrap = document.createElement("div");
    cardsWrap.className = "catalog-section-cards";
    items.forEach((item) => cardsWrap.appendChild(buildCard(item)));
    section.appendChild(cardsWrap);

    grid.appendChild(section);
  });

  applyScrollOffset(grid);
  setupCategoryObserver(sections.map((s) => s.cat));

  if (!sections.some((s) => s.cat === activeCategory)) {
    setActivePill(sections[0].cat);
  }
}

function applyScrollOffset(grid) {
  const topbar = document.querySelector(".topbar");
  const offset = (topbar ? topbar.offsetHeight : 88) + 8;
  grid.style.scrollMarginTop = offset + "px";
  grid.querySelectorAll(".catalog-section").forEach((s) => {
    s.style.scrollMarginTop = offset + "px";
  });
}

function setupCategoryObserver(cats) {
  const grid = document.getElementById("grid");
  categoryObserver = new IntersectionObserver(
    (entries) => {
      if (Date.now() < suppressObserverUntil) return;
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible.length > 0) {
        setActivePill(visible[0].target.dataset.cat);
      }
    },
    { root: null, rootMargin: "-10% 0px -75% 0px", threshold: 0 }
  );
  cats.forEach((cat) => {
    const section = grid.querySelector(`.catalog-section[data-cat="${cssEscape(cat)}"]`);
    if (section) categoryObserver.observe(section);
  });
}

function buildCard(item) {
  const card = document.createElement("div");
  card.className = "card";

  const imgWrap = document.createElement("div");
  const imgSrc = item.img || `photos/${item.id}.jpg?v=2`;
  const img = document.createElement("img");
  img.className = "card-img";
  img.loading = "lazy"; // Быстрая ленивая загрузка
  img.src = imgSrc;
  img.alt = item.v;
  img.onerror = () => handleImgError(img, item.id);
  imgWrap.appendChild(img);
  card.appendChild(imgWrap);

  const body = document.createElement("div");
  body.className = "card-body";
  body.innerHTML = `
    <div class="card-name">${escapeHtml(item.v)}</div>
    <div class="card-week">${weekLabel(item)}</div>
    <div class="card-bottom">
      <span class="card-price">${fmtMoney(unitPrice(item))} ₽</span>
    </div>
  `;
  const bottom = body.querySelector(".card-bottom");
  const inCart = cart[item.a];
  if (inCart) {
    const stepper = document.createElement("div");
    stepper.className = "card-qty-stepper";

    const minusBtn = document.createElement("button");
    minusBtn.textContent = "−";
    minusBtn.onclick = (e) => {
      e.stopPropagation();
      const newQty = (cart[item.a] || 0) - 1;
      if (newQty <= 0) delete cart[item.a];
      else cart[item.a] = newQty;
      renderGrid();
      updateCartBar();
    };

    const qtySpan = document.createElement("span");
    qtySpan.textContent = inCart;

    const plusBtn = document.createElement("button");
    plusBtn.textContent = "+";
    plusBtn.onclick = (e) => {
      e.stopPropagation();
      cart[item.a] = (cart[item.a] || 0) + 1;
      renderGrid();
      updateCartBar();
    };

    stepper.appendChild(minusBtn);
    stepper.appendChild(qtySpan);
    stepper.appendChild(plusBtn);
    bottom.appendChild(stepper);
  } else {
    const addBtn = document.createElement("button");
    addBtn.className = "card-add";
    addBtn.textContent = "+";
    addBtn.onclick = (e) => {
      e.stopPropagation();
      cart[item.a] = (cart[item.a] || 0) + 1;
      renderGrid();
      updateCartBar();
    };
    bottom.appendChild(addBtn);
  }
  card.appendChild(body);
  card.onclick = () => openItem(item.a);
  return card;
}

function placeholderEl() {
  const div = document.createElement("div");
  div.className = "card-img-placeholder";
  div.textContent = "фото";
  return div;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- item detail ----------
function openItem(article) {
  currentItemArticle = article;
  const item = ARTICLE_TO_ITEM[article];
  const detail = document.getElementById("item-detail");
  const existingQty = cart[article] || 1;

  const imgSrc = item.img || `photos/${item.id}.jpg?v=2`;
  const imgHtml = `<img class="item-img" src="${imgSrc}" alt="${escapeHtml(item.v)}" onerror="handleImgError(this, ${item.id})" />`;

  detail.innerHTML = `
    ${imgHtml}
    <div class="item-name">${escapeHtml(item.v)}</div>
    <div class="item-meta">${escapeHtml(item.c)} · арт. ${item.a} · ${weekLabel(item)}</div>
    <div class="item-price">${fmtMoney(unitPrice(item))} ₽ / шт</div>
    <div class="qty-row">
      <button class="qty-btn" id="qty-minus">−</button>
      <span class="qty-value" id="qty-value">${existingQty}</span>
      <button class="qty-btn" id="qty-plus">+</button>
    </div>
  `;

  document.getElementById("qty-minus").onclick = () => changeQty(-1);
  document.getElementById("qty-plus").onclick = () => changeQty(1);

  pushScreen("item");
}

function changeQty(delta) {
  const el = document.getElementById("qty-value");
  let val = Number(el.textContent) + delta;
  if (val < 1) val = 1;
  el.textContent = val;
  updateTelegramButtons("item");
}

function addCurrentItemToCart() {
  const qty = Number(document.getElementById("qty-value").textContent);
  cart[currentItemArticle] = qty;
  if (tg) tg.HapticFeedback.notificationOccurred("success");
  popScreen();
  renderGrid();
}

// ---------- cart bar ----------
function updateCartBar() {
  const bar = document.getElementById("cart-bar");
  const count = cartCount();
  const screenName = screenStack[screenStack.length - 1];
  if (screenName !== "catalog") {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  document.getElementById("cart-bar-count").textContent = `Корзина: ${count} шт`;
  if (count > 0) {
    const totals = computeTotals(deliveryMethod);
    document.getElementById("cart-bar-total").textContent = `${fmtMoney(totals.itemsTotal)} ₽`;
  } else {
    document.getElementById("cart-bar-total").textContent = "";
  }
  bar.onclick = () => {
    screenStack = ["catalog", "cart"];
    renderCartScreen();
    showScreen("cart");
  };
}

// ---------- cart screen ----------
function renderCartScreen() {
  const list = document.getElementById("cart-list");
  const emptyEl = document.getElementById("cart-empty");
  const summaryEl = document.getElementById("cart-summary");
  list.innerHTML = "";

  const totals = computeTotals(deliveryMethod);
  if (totals.lines.length === 0) {
    emptyEl.hidden = false;
    summaryEl.innerHTML = "";
    updateTelegramButtons("cart");
    return;
  }
  emptyEl.hidden = true;

  totals.lines.forEach(({ item, qty, lineTotal }) => {
    const row = document.createElement("div");
    row.className = "cart-row";
    const imgSrc = item.img || `photos/${item.id}.jpg?v=2`;
    const imgHtml = `<img class="cart-row-img" src="${imgSrc}" alt="" onerror="handleImgError(this, ${item.id})" />`;
    row.innerHTML = `
      ${imgHtml}
      <div class="cart-row-info">
        <div class="cart-row-name">${escapeHtml(item.v)}</div>
        <div class="cart-row-price">${qty} шт × ${fmtMoney(unitPrice(item))} ₽ = ${fmtMoney(lineTotal)} ₽</div>
      </div>
      <div class="cart-row-controls">
        <button class="cart-row-minus">−</button>
        <input type="number" class="cart-row-qty-input" inputmode="numeric" min="1" step="1" value="${qty}" />
        <button class="cart-row-plus">+</button>
        <button class="cart-row-remove">×</button>
      </div>
    `;
    row.querySelector(".cart-row-minus").onclick = () => {
      cart[item.a] = Math.max(1, (cart[item.a] || 1) - 1);
      renderCartScreen();
    };
    row.querySelector(".cart-row-plus").onclick = () => {
      cart[item.a] = (cart[item.a] || 0) + 1;
      renderCartScreen();
    };
    row.querySelector(".cart-row-remove").onclick = () => {
      delete cart[item.a];
      renderCartScreen();
    };

    const qtyInput = row.querySelector(".cart-row-qty-input");
    const applyQtyInput = () => {
      let val = Math.floor(Number(qtyInput.value));
      if (!Number.isFinite(val) || val < 1) val = 1;
      cart[item.a] = val;
      qtyInput.value = val;
      updateCartLineDisplay(row, item, val);
      updateCartBar();
      updateCartSummary();
    };
    qtyInput.addEventListener("change", applyQtyInput);
    qtyInput.addEventListener("blur", applyQtyInput);
    qtyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        qtyInput.blur();
      }
    });

    list.appendChild(row);
  });

  updateCartSummary();
  updateTelegramButtons("cart");
}

function updateCartLineDisplay(row, item, qty) {
  const priceEl = row.querySelector(".cart-row-price");
  const lineTotal = unitPrice(item) * qty;
  if (priceEl) {
    priceEl.textContent = `${qty} шт × ${fmtMoney(unitPrice(item))} ₽ = ${fmtMoney(lineTotal)} ₽`;
  }
}

function updateCartSummary() {
  const summaryEl = document.getElementById("cart-summary");
  if (!summaryEl) return;
  const totals = computeTotals(deliveryMethod);
  summaryEl.innerHTML = `
    <div class="summary-row"><span>Товары</span><span>${fmtMoney(totals.itemsTotal)} ₽</span></div>
    <div class="summary-row"><span>${deliveryMethod === "pickup" ? "Самовывоз" : deliveryMethod === "delivery" ? "Доставка" : "Доставка/самовывоз"}</span><span>${deliveryMethod ? fmtMoney(totals.deliveryTotal) + " ₽" : "уточняется"}</span></div>
    <div class="summary-row total"><span>Итого</span><span>${fmtMoney(totals.grandTotal)} ₽${deliveryMethod ? "" : " + доставка"}</span></div>
  `;
}

// ---------- checkout screen ----------
function updateDeliveryFieldsVisibility() {
  const isPickup = deliveryMethod === "pickup";
  const isDelivery = deliveryMethod === "delivery";
  document.getElementById("pickup-address-note").hidden = !isPickup;
  document.getElementById("pickup-address-note").textContent =
    "Адрес самовывоза: " + PICKUP_ADDRESS + ". " + PICKUP_NOTE_EXTRA;
  document.getElementById("delivery-method-note").hidden = !isDelivery;
  document.getElementById("delivery-address-fields").hidden = !isDelivery;
}

function openCheckout() {
  if (cartCount() === 0) return;
  document.querySelectorAll(".toggle-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.method === deliveryMethod);
  });
  updateDeliveryFieldsVisibility();
  renderCheckoutSummary();
  pushScreen("checkout");
}

document.querySelectorAll(".toggle-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    deliveryMethod = btn.dataset.method;
    document.querySelectorAll(".toggle-btn").forEach((b) => b.classList.toggle("active", b === btn));
    updateDeliveryFieldsVisibility();
    renderCheckoutSummary();
  });
});

function renderCheckoutSummary() {
  const totals = computeTotals(deliveryMethod);
  document.getElementById("checkout-summary").innerHTML = `
    <div class="summary-row"><span>Товары</span><span>${fmtMoney(totals.itemsTotal)} ₽</span></div>
    <div class="summary-row"><span>${deliveryMethod === "pickup" ? "Самовывоз" : deliveryMethod === "delivery" ? "Доставка" : "Доставка/самовывоз"}</span><span>${deliveryMethod ? fmtMoney(totals.deliveryTotal) + " ₽" : "уточняется"}</span></div>
    <div class="summary-row total"><span>Итого</span><span>${fmtMoney(totals.grandTotal)} ₽${deliveryMethod ? "" : " + доставка"}</span></div>
  `;
}

function formatPhoneInput(e) {
  let digits = e.target.value.replace(/\D/g, "");
  if (digits.startsWith("8")) digits = "7" + digits.slice(1);
  if (!digits.startsWith("7")) digits = "7" + digits;
  digits = digits.slice(0, 11);

  let formatted = "+7";
  if (digits.length > 1) formatted += " (" + digits.slice(1, 4);
  if (digits.length >= 4) formatted += ") " + digits.slice(4, 7);
  if (digits.length >= 7) formatted += "-" + digits.slice(7, 9);
  if (digits.length >= 9) formatted += "-" + digits.slice(9, 11);
  e.target.value = formatted;
}
document.getElementById("phone-input").addEventListener("input", formatPhoneInput);
document.getElementById("phone-input").addEventListener("focus", (e) => {
  if (!e.target.value) e.target.value = "+7 ";
});

document.getElementById("name-input").addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/[^A-Za-zА-Яа-яЁё\s-]/g, "");
});

function submitOrder() {
  const name = document.getElementById("name-input").value.trim();
  const phone = document.getElementById("phone-input").value.trim();
  const comment = document.getElementById("comment-input").value.trim();
  const errEl = document.getElementById("checkout-error");

  if (!deliveryMethod) {
    errEl.textContent = "Выберите способ получения заказа.";
    errEl.hidden = false;
    if (tg) tg.HapticFeedback.notificationOccurred("error");
    return;
  }

  const phoneDigits = phone.replace(/\D/g, "");
  const nameParts = name.split(/\s+/).filter(Boolean);

  if (nameParts.length < 2) {
    errEl.textContent = "Укажите ФИО полностью (фамилия и имя).";
    errEl.hidden = false;
    if (tg) tg.HapticFeedback.notificationOccurred("error");
    return;
  }
  if (phoneDigits.length !== 11) {
    errEl.textContent = "Укажите телефон полностью, в формате +7 (999) 123-45-67.";
    errEl.hidden = false;
    if (tg) tg.HapticFeedback.notificationOccurred("error");
    return;
  }

  let deliveryAddress = null;
  if (deliveryMethod === "delivery") {
    const city = document.getElementById("addr-city").value.trim();
    const pvz = document.getElementById("addr-pvz").value.trim();

    if (!city || !pvz) {
      errEl.textContent = "Укажите город и адрес ближайшего ПВЗ СДЭК для доставки.";
      errEl.hidden = false;
      if (tg) tg.HapticFeedback.notificationOccurred("error");
      return;
    }

    const formatted = `г. ${city}, ПВЗ СДЭК: ${pvz}`;
    deliveryAddress = { city, pvz, formatted };
  }

  errEl.hidden = true;

  const items = Object.keys(cart).map((a) => ({ a: Number(a), qty: cart[a] }));
  const payload = {
    items,
    delivery_method: deliveryMethod,
    delivery_address: deliveryAddress,
    customer_name: name,
    phone,
    comment,
  };

  if (tg) {
    tg.MainButton.showProgress();
    tg.sendData(JSON.stringify(payload));
  } else {
    alert("Заказ отправлен (тестовый режим, не в Telegram):\n" + JSON.stringify(payload, null, 2));
  }
}

// ---------- search ----------
document.getElementById("search-input").addEventListener("input", (e) => {
  searchQuery = e.target.value;
  renderGrid();
});

// ---------- sort ----------
document.getElementById("sort-select").addEventListener("change", (e) => {
  sortMode = e.target.value;
  renderGrid();
});

// ---------- init ----------
async function init() {
  try {
    const res = await fetch(CATALOG_URL);
    CATALOG = await res.json();
  } catch (e) {
    document.getElementById("grid").innerHTML =
      '<div class="empty-state">Не удалось загрузить каталог. Проверьте файл catalog.json.</div>';
    return;
  }
  CATEGORIES = [...new Set(CATALOG.map((i) => i.c))].sort();
  ARTICLE_TO_ITEM = {};
  CATALOG.forEach((item) => {
    if (!(item.a in ARTICLE_TO_ITEM)) ARTICLE_TO_ITEM[item.a] = item;
  });
  renderCategories();
  renderGrid();
  showScreen("catalog");
}

init();