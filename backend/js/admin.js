import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { db, storage } from "./firebase-config.js";

let productsCache = [];
let categoriesCache = [];
let ordersCache = [];
let settingsCache = {};
let accountBalance = 0;

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatINR(n) {
  return "₹" + Number(n || 0).toLocaleString("en-IN");
}

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/**
 * Upload image to Firebase Storage; if Storage is not enabled or fails,
 * falls back to a compressed JPEG Data URL so the shop owner is never blocked.
 */
async function uploadImageFile(file, folder = "products") {
  try {
    const safeName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const storageRef = ref(storage, `${folder}/${safeName}`);
    await uploadBytes(storageRef, file);
    return await getDownloadURL(storageRef);
  } catch (err) {
    console.warn("Firebase Storage upload unavailable, using compressed inline image fallback:", err);
    return await compressImageToDataUrl(file, folder === "branding" ? 420 : 900);
  }
}

function compressImageToDataUrl(file, maxWidth = 900) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.78));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Public Admin Boot (no sign-in or security gate)
document.getElementById("refresh-all-btn")?.addEventListener("click", async () => {
  await refreshAll();
  toast("Data refreshed");
});
refreshAll();

// Sidebar Navigation
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.panel;
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    document.getElementById(`panel-${target}`)?.classList.add("active");
    document.getElementById("panel-title").textContent = btn.textContent.trim();
  });
});

async function refreshAll() {
  await Promise.all([
    loadFinance(),
    loadCategories(),
    loadProducts(),
    loadOrders(),
    loadSettings(),
    loadMessages()
  ]);
  updateKpis();
}

async function loadFinance() {
  try {
    const snap = await getDoc(doc(db, "stats", "finance"));
    accountBalance = snap.exists() ? Number(snap.data().accountBalance || 0) : 0;
  } catch {
    accountBalance = 0;
  }
}

async function loadCategories() {
  const snap = await getDocs(collection(db, "categories"));
  categoriesCache = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  renderCategories();
}

async function loadProducts() {
  const snap = await getDocs(collection(db, "products"));
  productsCache = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  renderProducts();
  renderDiscountItemCheckboxes();
}

async function loadOrders() {
  const snap = await getDocs(collection(db, "orders"));
  ordersCache = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  renderOrders();
}

async function loadSettings() {
  const snap = await getDoc(doc(db, "settings", "store"));
  settingsCache = snap.exists() ? snap.data() : {};
  populateSettingsForms();
}

async function loadMessages() {
  try {
    const snap = await getDocs(collection(db, "messages"));
    const list = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    const tbody = document.getElementById("messages-tbody");
    if (!tbody) return;
    tbody.innerHTML = list.length
      ? list
          .map(
            (m) => `
          <tr>
            <td><strong>${escapeHtml(m.name)}</strong><br/><small>${escapeHtml(m.phone || "")} ${escapeHtml(m.email || "")}</small></td>
            <td>${escapeHtml(m.message)}</td>
          </tr>`
          )
          .join("")
      : `<tr><td colspan="2" style="color:var(--text-muted);">No customer messages yet.</td></tr>`;
  } catch {
    // ignore if rules block
  }
}

function updateKpis() {
  document.getElementById("kpi-balance").textContent = formatINR(accountBalance);
  document.getElementById("kpi-stock").textContent = String(productsCache.length);
  document.getElementById("kpi-orders").textContent = String(ordersCache.length);
  const deliveredCount = ordersCache.filter((o) => o.status === "Delivered").length;
  const pendingCount = ordersCache.filter((o) => o.status !== "Delivered" && o.status !== "Cancelled").length;
  document.getElementById("kpi-delivered").textContent = String(deliveredCount);
  document.getElementById("kpi-pending").textContent = String(pendingCount);
}

// 1. Add Item
document.getElementById("add-product-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("add-product-btn");
  btn.disabled = true;
  btn.textContent = "Saving Item...";

  try {
    const fileInput = document.getElementById("p-photo-file");
    let imageUrl = document.getElementById("p-photo-url").value.trim();
    if (fileInput.files && fileInput.files[0]) {
      imageUrl = await uploadImageFile(fileInput.files[0], "products");
    }

    const sizes = Array.from(document.querySelectorAll('input[name="p-size"]:checked')).map((i) => i.value);
    const originalPrice = Number(document.getElementById("p-orig-price").value || 0);
    const discountedInput = document.getElementById("p-disc-price").value;
    const discountedPrice = discountedInput !== "" ? Number(discountedInput) : originalPrice;

    await addDoc(collection(db, "products"), {
      name: document.getElementById("p-name").value.trim(),
      category: document.getElementById("p-category").value || "Lady Suits",
      originalPrice,
      discountedPrice,
      sizes: sizes.length ? sizes : ["Free Size"],
      stockQty: Number(document.getElementById("p-qty").value || 1),
      fabric: document.getElementById("p-fabric").value.trim(),
      color: document.getElementById("p-color").value.trim(),
      work: document.getElementById("p-work").value.trim(),
      care: document.getElementById("p-care").value.trim(),
      description: document.getElementById("p-desc").value.trim(),
      imageUrl,
      createdAt: serverTimestamp()
    });

    e.target.reset();
    toast("Item added to live stock!");
    await loadProducts();
    updateKpis();
  } catch (err) {
    console.error(err);
    toast("Error adding item: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Add Item to Stock";
  }
});

function renderProducts() {
  const tbody = document.getElementById("products-tbody");
  if (!tbody) return;
  if (!productsCache.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-muted);text-align:center;padding:24px;">Zero items in stock right now. Add your first Lady Suit or Kurti above.</td></tr>`;
    return;
  }
  tbody.innerHTML = productsCache
    .map((p) => {
      const orig = Number(p.originalPrice || 0);
      const disc = Number(p.discountedPrice || orig);
      const pct = orig > disc ? Math.round(((orig - disc) / orig) * 100) : 0;
      return `
        <tr>
          <td>${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" class="thumb-sm" alt="" />` : "—"}</td>
          <td>
            <strong>${escapeHtml(p.name)}</strong><br/>
            <small style="color:var(--text-muted);">${escapeHtml(p.fabric || "")} ${escapeHtml(p.color || "")}</small>
          </td>
          <td>${escapeHtml(p.category || "")}</td>
          <td>
            <strong>${formatINR(disc)}</strong>
            ${pct > 0 ? `<br/><small style="text-decoration:line-through;color:var(--text-muted);">${formatINR(orig)}</small> <span class="badge">${pct}% OFF</span>` : ""}
          </td>
          <td>${escapeHtml((p.sizes || []).join(", "))}</td>
          <td>
            <button type="button" class="btn btn-danger btn-sm remove-product-btn" data-id="${escapeHtml(p.id)}">Remove</button>
          </td>
        </tr>`;
    })
    .join("");

  tbody.querySelectorAll(".remove-product-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this item from stock?")) return;
      await deleteDoc(doc(db, "products", btn.dataset.id));
      toast("Item removed");
      await loadProducts();
      updateKpis();
    });
  });
}

// 2. Categories
function renderCategories() {
  const listEl = document.getElementById("categories-list");
  const prodSelect = document.getElementById("p-category");
  const discCatSelect = document.getElementById("disc-category-select");

  const opts = categoriesCache.length
    ? categoriesCache.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("")
    : `<option value="Lady Suits">Lady Suits (Add categories in Categories tab)</option>`;
  if (prodSelect) prodSelect.innerHTML = opts;
  if (discCatSelect) discCatSelect.innerHTML = opts;

  if (!listEl) return;
  if (!categoriesCache.length) {
    listEl.innerHTML = `<p style="color:var(--text-muted);">No categories yet. Add categories like Lady Suits, Kurtis, Unstitched Suits, Festive Wear.</p>`;
    return;
  }
  listEl.innerHTML = categoriesCache
    .map(
      (c) => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border:1px solid var(--silver-light);border-radius:12px;margin-bottom:8px;">
        <strong>${escapeHtml(c.name)}</strong>
        <button type="button" class="btn btn-danger btn-sm del-cat-btn" data-id="${escapeHtml(c.id)}">Delete</button>
      </div>`
    )
    .join("");

  listEl.querySelectorAll(".del-cat-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await deleteDoc(doc(db, "categories", btn.dataset.id));
      toast("Category deleted");
      await loadCategories();
    });
  });
}

document.getElementById("add-category-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("new-category-name");
  const name = input.value.trim();
  if (!name) return;
  await addDoc(collection(db, "categories"), { name, createdAt: serverTimestamp() });
  input.value = "";
  toast(`Category "${name}" added`);
  await loadCategories();
});

// 3. Bulk & Multi-Item Discount Offers
function renderDiscountItemCheckboxes() {
  const wrap = document.getElementById("disc-items-list");
  if (!wrap) return;
  if (!productsCache.length) {
    wrap.innerHTML = `<p style="color:var(--text-muted);margin:0;">Add stock items first to apply item-level discounts.</p>`;
    return;
  }
  wrap.innerHTML = productsCache
    .map(
      (p) => `
      <label class="size-chip">
        <input type="checkbox" name="disc-item" value="${escapeHtml(p.id)}" />
        <span>${escapeHtml(p.name)} (${formatINR(p.originalPrice)})</span>
      </label>`
    )
    .join("");
}

document.getElementById("discount-scope")?.addEventListener("change", (e) => {
  document.getElementById("disc-cat-wrap").style.display = e.target.value === "category" ? "block" : "none";
  document.getElementById("disc-items-wrap").style.display = e.target.value === "selected" ? "block" : "none";
});

document.getElementById("apply-discount-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const scope = document.getElementById("discount-scope").value;
  const pct = Number(document.getElementById("discount-percent").value || 0);
  if (pct < 0 || pct > 95) {
    toast("Enter a discount between 0% and 95%");
    return;
  }

  let targets = [];
  if (scope === "all") {
    targets = productsCache;
  } else if (scope === "category") {
    const cat = document.getElementById("disc-category-select").value;
    targets = productsCache.filter((p) => p.category === cat);
  } else {
    const ids = new Set(Array.from(document.querySelectorAll('input[name="disc-item"]:checked')).map((i) => i.value));
    targets = productsCache.filter((p) => ids.has(p.id));
  }

  if (!targets.length) {
    toast("No matching items selected");
    return;
  }

  for (const item of targets) {
    const orig = Number(item.originalPrice || item.discountedPrice || 0);
    const newPrice = Math.max(1, Math.round(orig * (1 - pct / 100)));
    await updateDoc(doc(db, "products", item.id), { discountedPrice: newPrice });
  }

  toast(`Applied ${pct}% discount to ${targets.length} item(s)`);
  await loadProducts();
});

// 4. Orders & Delivered -> Account Balance Earnings Increment
function renderOrders() {
  const tbody = document.getElementById("orders-tbody");
  if (!tbody) return;
  if (!ordersCache.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-muted);text-align:center;padding:24px;">No customer orders yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = ordersCache
    .map((o) => {
      const addr = [o.addressLine1, o.addressLine2, o.city, o.state].filter(Boolean).join(", ");
      const itemsText = (o.items || [])
        .map((i) => `${escapeHtml(i.name)} (${escapeHtml(i.size)}) × ${i.qty}`)
        .join("<br/>");
      const isDelivered = o.status === "Delivered";
      return `
        <tr>
          <td>
            <strong>#${escapeHtml(o.id.slice(0, 8).toUpperCase())}</strong><br/>
            <span class="badge ${escapeHtml(o.status || "Pending")}">${escapeHtml(o.status || "Pending")}</span>
          </td>
          <td>
            <strong>${escapeHtml(o.customerName)}</strong><br/>
            <span>${escapeHtml(o.phone)}</span><br/>
            <small style="color:var(--text-muted);">${escapeHtml(addr)} — <strong>PIN: ${escapeHtml(o.pincode)}</strong></small>
          </td>
          <td>${itemsText}</td>
          <td>
            <strong>${formatINR(o.totalAmount)}</strong><br/>
            <small>${escapeHtml(o.paymentMethod || "Cash on Delivery")}</small>
          </td>
          <td>
            ${
              isDelivered
                ? `<span style="color:var(--success);font-weight:700;">Delivered &amp; Credited</span>`
                : `<button type="button" class="btn btn-success btn-sm mark-delivered-btn" data-id="${escapeHtml(o.id)}">Mark Delivered</button>`
            }
          </td>
        </tr>`;
    })
    .join("");

  tbody.querySelectorAll(".mark-delivered-btn").forEach((btn) => {
    btn.addEventListener("click", () => markOrderDelivered(btn.dataset.id, btn));
  });
}

async function markOrderDelivered(orderId, btn) {
  btn.disabled = true;
  btn.textContent = "Updating...";
  try {
    await runTransaction(db, async (tx) => {
      const orderRef = doc(db, "orders", orderId);
      const financeRef = doc(db, "stats", "finance");
      const [orderSnap, finSnap] = await Promise.all([tx.get(orderRef), tx.get(financeRef)]);
      if (!orderSnap.exists()) throw new Error("Order not found");
      const orderData = orderSnap.data();
      if (orderData.earningsCredited) return;

      const currentBal = finSnap.exists() ? Number(finSnap.data().accountBalance || 0) : 0;
      const orderAmt = Number(orderData.totalAmount || 0);

      tx.update(orderRef, {
        status: "Delivered",
        earningsCredited: true,
        deliveredAt: serverTimestamp()
      });
      tx.set(
        financeRef,
        {
          accountBalance: currentBal + orderAmt,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    });

    toast("Order marked Delivered — Account Balance updated!");
    await Promise.all([loadFinance(), loadOrders()]);
    updateKpis();
  } catch (err) {
    console.error(err);
    toast("Failed to update order: " + err.message);
    btn.disabled = false;
    btn.textContent = "Mark Delivered";
  }
}

// 5. Branding (Logo + Optional Sale Tag) & Page Content Editors
function populateSettingsForms() {
  const s = settingsCache || {};
  // Logo preview
  const logoPreview = document.getElementById("current-logo-preview");
  if (logoPreview) {
    logoPreview.innerHTML = s.logoUrl
      ? `<img src="${escapeHtml(s.logoUrl)}" alt="Current Logo" style="height:56px;border-radius:10px;border:1px solid var(--gold-border);padding:4px;background:#fff;" />`
      : `<img src="assets/logo.png" alt="Sumji Fabrics Logo" style="height:56px;width:56px;border-radius:50%;border:1.5px solid var(--gold-border);background:#fff;" />`;
  }
  // Sale Banner
  const sb = s.saleBanner || {};
  document.getElementById("sale-enabled").checked = Boolean(sb.enabled);
  document.getElementById("sale-offer-name").value = sb.offerName || "";
  document.getElementById("sale-offer-text").value = sb.saleText || "";
  updateSalePreview();

  // Contact
  const c = s.contact || {};
  document.getElementById("set-phone").value = c.phone || "9469095816 / 6006730151";
  document.getElementById("set-whatsapp").value = c.whatsapp || "919469095816";
  document.getElementById("set-instagram").value = c.instagram || "sumji__fabrics";
  document.getElementById("set-email").value = c.email || "";
  document.getElementById("set-hours").value = c.hours || "Open Daily — Visit or DM for Orders";
  document.getElementById("set-contact-addr").value = c.address || "Main Chowk, Opp. War Building, Sopore, Jammu & Kashmir";

  // About
  const a = s.about || {};
  document.getElementById("set-about-head").value = a.headline || "Finest Quality Textiles — Style • Elegance • Quality";
  document.getElementById("set-about-desc").value = a.description || "Sumji Fabrics, located at Main Chowk (Opp. War Building), Sopore, brings you a premium and clean collection of lady suits, kurtis, and ethnic wear.";
  document.getElementById("set-about-craft").value = a.craftsmanship || "From graceful everyday kurtis to festive lady suits and finest quality textiles, Sumji Fabrics is dedicated to authentic fabrics, refined finishing, and dependable service.";

  // Location
  const l = s.location || {};
  document.getElementById("set-loc-addr").value = l.address || "Main Chowk, Opp. War Building";
  document.getElementById("set-loc-landmark").value = l.landmark || "Opposite War Building, Main Chowk";
  document.getElementById("set-loc-city").value = l.city || "Sopore, Jammu & Kashmir";
  document.getElementById("set-loc-hours").value = l.hours || "Visit our store or call 9469095816 / 6006730151";
  document.getElementById("set-loc-maps-link").value = l.mapsLink || "https://www.google.com/maps/search/?api=1&query=Main+Chowk+Opp+War+Building+Sopore+Jammu+and+Kashmir";
  document.getElementById("set-loc-maps-embed").value = l.mapsEmbedUrl || "https://maps.google.com/maps?q=Main%20Chowk%20Sopore%20Jammu%20and%20Kashmir&t=&z=16&ie=UTF8&iwloc=&output=embed";
}

function updateSalePreview() {
  const on = document.getElementById("sale-enabled").checked;
  const name = document.getElementById("sale-offer-name").value.trim() || "FESTIVE SALE";
  const text = document.getElementById("sale-offer-text").value.trim() || "Up to 25% OFF on Lady Suits";
  const box = document.getElementById("sale-preview-box");
  if (!box) return;
  box.innerHTML = on
    ? `<div class="preview-banner"><span class="sale-pill">${escapeHtml(name)}</span><strong>${escapeHtml(text)}</strong></div>`
    : `<p style="color:var(--text-muted);font-size:0.84rem;margin:8px 0 0;">Sale tag is currently hidden on the storefront header.</p>`;
}

["sale-enabled", "sale-offer-name", "sale-offer-text"].forEach((id) => {
  document.getElementById(id)?.addEventListener("input", updateSalePreview);
  document.getElementById(id)?.addEventListener("change", updateSalePreview);
});

document.getElementById("branding-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("save-branding-btn");
  btn.disabled = true;
  try {
    let logoUrl = settingsCache.logoUrl || "";
    const file = document.getElementById("logo-file-input").files[0];
    if (file) {
      logoUrl = await uploadImageFile(file, "branding");
    }
    const saleBanner = {
      enabled: document.getElementById("sale-enabled").checked,
      offerName: document.getElementById("sale-offer-name").value.trim(),
      saleText: document.getElementById("sale-offer-text").value.trim()
    };
    await setDoc(doc(db, "settings", "store"), { logoUrl, saleBanner }, { merge: true });
    toast("Header logo & sale tag updated!");
    await loadSettings();
  } catch (err) {
    toast("Error saving branding: " + err.message);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("reset-logo-btn")?.addEventListener("click", async () => {
  await setDoc(doc(db, "settings", "store"), { logoUrl: "" }, { merge: true });
  toast("Logo reset to default monogram");
  await loadSettings();
});

document.getElementById("pages-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await setDoc(
      doc(db, "settings", "store"),
      {
        contact: {
          phone: document.getElementById("set-phone").value.trim(),
          whatsapp: document.getElementById("set-whatsapp").value.trim(),
          instagram: document.getElementById("set-instagram").value.trim(),
          email: document.getElementById("set-email").value.trim(),
          hours: document.getElementById("set-hours").value.trim(),
          address: document.getElementById("set-contact-addr").value.trim()
        },
        about: {
          headline: document.getElementById("set-about-head").value.trim(),
          description: document.getElementById("set-about-desc").value.trim(),
          craftsmanship: document.getElementById("set-about-craft").value.trim()
        },
        location: {
          address: document.getElementById("set-loc-addr").value.trim(),
          landmark: document.getElementById("set-loc-landmark").value.trim(),
          city: document.getElementById("set-loc-city").value.trim(),
          hours: document.getElementById("set-loc-hours").value.trim(),
          mapsLink: document.getElementById("set-loc-maps-link").value.trim(),
          mapsEmbedUrl: document.getElementById("set-loc-maps-embed").value.trim()
        }
      },
      { merge: true }
    );
    toast("Contact, About & Location pages updated!");
    await loadSettings();
  } catch (err) {
    toast("Error saving pages: " + err.message);
  }
});
