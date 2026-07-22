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
function renderCategories() {
  const wrap = document.getElementById("category-tabs");
  wrap.innerHTML = "";
  const all = document.createElement("button");
  all.className = "cat-pill" + (activeCategory === "__all__" ? " active" : "");
  all.textContent = "Все";
  all.onclick = () => {
    activeCategory = "__all__";
    renderCategories();
    renderGrid();
  };
  wrap.appendChild(all);

  CATEGORIES.forEach((cat) => {
    const pill = document.createElement("button");
    pill.className = "cat-pill" + (activeCategory === cat ? " active" : "");
    pill.textContent = cat;
    pill.onclick = () => {
      activeCategory = cat;
      renderCategories();
      renderGrid();
    };
    wrap.appendChild(pill);
  });
}

function filteredItems() {
  const q = searchQuery.trim().toLowerCase();
  return CATALOG.filter((item) => {
    const matchesCategory = activeCategory === "__all__" || item.c === activeCategory;
    const matchesSearch = !q || item.v.toLowerCase().includes(q);
    return matchesCategory && matchesSearch;
  });
}

function renderGrid() {
  const grid = document.getElementById("grid");
  const empty = document.getElementById("empty-state");
  const items = filteredItems();
  grid.innerHTML = "";

  if (items.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "card";

    const imgWrap = document.createElement("div");
    if (item.img) {
      const img = document.createElement("img");
      img.className = "card-img";
      img.src = item.img;
      img.alt = item.v;
      img.onerror = () => {
        img.replaceWith(placeholderEl());
      };
      imgWrap.appendChild(img);
    } else {
      imgWrap.appendChild(placeholderEl());
    }
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
    grid.appendChild(card);
  });
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

  const imgHtml = item.img
    ? `<img class="item-img" src="${item.img}" alt="${escapeHtml(item.v)}" onerror="this.replaceWith(Object.assign(document.createElement('div'), {className:'item-img-placeholder', textContent:'фото'}))" />`
    : `<div class="item-img-placeholder">фото</div>`;

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
    const imgHtml = item.img
      ? `<img class="cart-row-img" src="${item.img}" alt="" />`
      : `<div class="cart-row-img"></div>`;
    row.innerHTML = `
      ${imgHtml}
      <div class="cart-row-info">
        <div class="cart-row-name">${escapeHtml(item.v)}</div>
        <div class="cart-row-price">${qty} шт × ${fmtMoney(unitPrice(item))} ₽ = ${fmtMoney(lineTotal)} ₽</div>
      </div>
      <div class="cart-row-controls">
        <button class="cart-row-minus">−</button>
        <span>${qty}</span>
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
    list.appendChild(row);
  });

  summaryEl.innerHTML = `
    <div class="summary-row"><span>Товары</span><span>${fmtMoney(totals.itemsTotal)} ₽</span></div>
    <div class="summary-row"><span>${deliveryMethod === "pickup" ? "Самовывоз" : deliveryMethod === "delivery" ? "Доставка" : "Доставка/самовывоз"}</span><span>${deliveryMethod ? fmtMoney(totals.deliveryTotal) + " ₽" : "уточняется"}</span></div>
    <div class="summary-row total"><span>Итого</span><span>${fmtMoney(totals.grandTotal)} ₽${deliveryMethod ? "" : " + доставка"}</span></div>
  `;
  updateTelegramButtons("cart");
}

// ---------- checkout screen ----------
function updateDeliveryFieldsVisibility() {
  const isPickup = deliveryMethod === "pickup";
  const isDelivery = deliveryMethod === "delivery";
  document.getElementById("pickup-address-note").hidden = !isPickup;
  document.getElementById("pickup-address-note").textContent =
    "Адрес самовывоза: " + PICKUP_ADDRESS + ". " + PICKUP_NOTE_EXTRA;
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

// маска телефона: приводит ввод к формату +7 (999) 123-45-67
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

// ФИО: разрешаем только буквы, пробелы и дефис
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
    const street = document.getElementById("addr-street").value.trim();
    const house = document.getElementById("addr-house").value.trim();
    const building = document.getElementById("addr-building").value.trim();
    const apartment = document.getElementById("addr-apartment").value.trim();

    if (!city || !street || !house) {
      errEl.textContent = "Укажите город, улицу и дом для доставки.";
      errEl.hidden = false;
      if (tg) tg.HapticFeedback.notificationOccurred("error");
      return;
    }

    let formatted = `г. ${city}, ул. ${street}, д. ${house}`;
    if (building) formatted += `, корп./стр. ${building}`;
    if (apartment) formatted += `, кв. ${apartment}`;

    deliveryAddress = { city, street, house, building, apartment, formatted };
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
    // Telegram закроет Web App автоматически после sendData
  } else {
    // локальный тест вне Telegram
    alert("Заказ отправлен (тестовый режим, не в Telegram):\n" + JSON.stringify(payload, null, 2));
  }
}

// ---------- search ----------
document.getElementById("search-input").addEventListener("input", (e) => {
  searchQuery = e.target.value;
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
