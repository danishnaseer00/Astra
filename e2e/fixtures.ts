// e2e/fixtures.ts — randomized fixture pages for the generality harness.
// Every run, the harness regenerates the ground truth (prices, stock, order
// IDs) and the pages are re-rendered from it: if the agent ever answered from
// memory or pattern-matching instead of the live DOM, the assertions fail.
// Labels/paths are deliberately gate-neutral (no pay/login/send/delete
// keywords) so the harness can run the whole battery under denyAll.

export interface CatalogProduct {
  name: string
  price: number
  stock: number
}

export interface ShopProduct extends CatalogProduct {
  slug: string
  description: string
}

const $ = (n: number) => `$${n.toFixed(2)}`

export function catalogPage(products: CatalogProduct[]): string {
  const rows = products
    .map((p) => `<tr><td>${p.name}</td><td>${$(p.price)}</td><td>${p.stock} in stock</td></tr>`)
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Nova Mart — catalog</title></head>
<body><h1>Nova Mart product catalog</h1>
<table border="1"><tr><th>Product</th><th>Price</th><th>Availability</th></tr>${rows}</table>
<p class="note">Prices in USD, updated daily. Exact price is shown next to each product name.</p>
</body></html>`
}

export function shopIndexPage(categories: { label: string; href: string }[]): string {
  const links = categories.map((c) => `<li><a href="${c.href}">${c.label}</a></li>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Gadget Depot</title></head>
<body><h1>Gadget Depot</h1><p>Shop by category:</p><ul>${links}</ul>
<p class="note">Browse a category to see product listings with prices and stock.</p></body></html>`
}

export function shopCategoryPage(name: string, products: ShopProduct[]): string {
  const cards = products
    .map(
      (p) =>
        `<div class="card"><h3><a href="/shop/${name}/${p.slug}">${p.name}</a></h3>
         <p class="price">${$(p.price)}</p><p>${p.stock} in stock</p></div>`
    )
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Gadget Depot — ${name}</title></head>
<body><h1>${name}</h1><div class="cards">${cards}</div>
<p class="note">Each card links to the product detail page, which lists the exact price and stock.</p></body></html>`
}

export function shopProductPage(p: ShopProduct): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${p.name} — Gadget Depot</title></head>
<body><h1>${p.name}</h1><p class="description">${p.description}</p>
<p class="price"><strong>${$(p.price)}</strong></p>
<p class="stock">In stock: ${p.stock} units</p>
<p class="note">The exact price of ${p.name} is ${$(p.price)}.</p></body></html>`
}

// The order form submits with a plain GET to /store/entry/confirm (native form
// behavior — the agent clicks "Continue" and the browser navigates with the
// field values). The order ID and total are generated SERVER-side at submit
// time, so the agent cannot read or guess them before filling the form.
export function orderFormPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Nova Mart — place an order</title></head>
<body><h1>Order entry</h1>
<form method="GET" action="/store/entry/confirm">
  <p><label>Full name <input type="text" name="name" placeholder="Your name"></label></p>
  <p><label>Email <input type="email" name="email" placeholder="you@example.com"></label></p>
  <p><label>Birth date <input type="date" name="birth"></label></p>
  <p><label>Country
    <select name="country">
      <option value="">— choose —</option>
      <option value="US">United States</option>
      <option value="UK">United Kingdom</option>
      <option value="JP">Japan</option>
    </select>
  </label></p>
  <p><button type="submit">Continue</button></p>
</form>
<p class="note">Fill the form and continue — the confirmation page shows your order ID.</p>
</body></html>`
}

export function orderConfirmPage(q: URLSearchParams, orderId: string, total: number): string {
  const name = q.get('name') ?? ''
  return `<!doctype html><html><head><meta charset="utf-8"><title>Order confirmed</title></head>
<body><h1>Thank you, ${name}</h1>
<p>Your order <strong>${orderId}</strong> is confirmed for ${name}.</p>
<p class="total">Total: <strong>${$(total)}</strong></p>
<p class="note">Order ${orderId} — total ${$(total)}.</p></body></html>`
}

export function itemPage(device: string, price: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${device} — device listing</title></head>
<body><h1>${device}</h1>
<p class="price"><strong>${$(price)}</strong></p>
<p class="note">The exact price of the ${device} is ${$(price)}.</p></body></html>`
}

// --- randomized ground truth --------------------------------------------------

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
const rand = (min: number, max: number) => Math.round((min + Math.random() * (max - min)) * 100) / 100
const randInt = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1))

export function randomCatalog(targetName: string): { products: CatalogProduct[]; target: CatalogProduct } {
  const names = ['GlidePad 8', 'VoltHub 300', 'Nimbus Keyboard', 'Echo Buds Pro', 'Luma Lamp', 'Drift Mouse']
  const target: CatalogProduct = { name: targetName, price: rand(10, 200), stock: randInt(1, 50) }
  const products: CatalogProduct[] = [target]
  for (const n of names) products.push({ name: n, price: rand(5, 300), stock: randInt(0, 99) })
  return { products, target }
}

export function randomShop(targetName: string): { index: { label: string; href: string }[]; category: string; products: ShopProduct[]; target: ShopProduct } {
  const category = pick(['Networking', 'Audio', 'Power'])
  const target: ShopProduct = {
    name: targetName,
    slug: 'flux-9000',
    price: rand(50, 400),
    stock: randInt(1, 40),
    description: `${targetName} is a compact ${category.toLowerCase()} device for home and office use.`,
  }
  const others: ShopProduct[] = [
    { name: 'Pico Switch', slug: 'pico-switch', price: rand(10, 100), stock: randInt(0, 60), description: 'A tiny unmanaged switch.' },
    { name: 'Beam Extender', slug: 'beam-extender', price: rand(20, 150), stock: randInt(0, 60), description: 'Extends wireless range.' },
    { name: 'Rail Mount Kit', slug: 'rail-kit', price: rand(5, 80), stock: randInt(0, 60), description: 'Mounting hardware.' },
  ]
  return {
    index: [
      { label: 'Networking', href: '/shop/Networking' },
      { label: 'Audio', href: '/shop/Audio' },
      { label: 'Power', href: '/shop/Power' },
    ],
    category,
    products: [...others, target],
    target,
  }
}

export const randomOrderId = () =>
  `ORD-${Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('')}`

export function hasPrice(answer: string, price: number): boolean {
  return new RegExp(`\\b${price.toFixed(2)}\\b`).test(answer)
}