const money = (n) => `$${n.toFixed(2)}`;
const $ = (sel) => document.querySelector(sel);

async function load() {
  const [user, cart] = await Promise.all([
    fetch('/api/user').then((r) => r.json()),
    fetch('/api/cart').then((r) => r.json()),
  ]);

  $('#user').textContent = `Signed in as ${user.name} (${user.plan})`;

  const rows = cart.items.map((item) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td class="num"></td><td class="num"></td>`;
    tr.children[0].textContent = item.name;
    tr.children[1].textContent = String(item.qty);
    tr.children[2].textContent = money(item.price * item.qty);
    return tr;
  });
  $('#items').replaceChildren(...rows);
  $('[data-testid=subtotal]').textContent = money(cart.subtotal);
  $('[data-testid=discount]').textContent = `-${money(cart.discount)}`;
  $('[data-testid=total]').textContent = money(cart.total);
}

$('#checkout').addEventListener('click', async () => {
  const result = $('#result');
  result.className = '';
  result.textContent = 'Placing order…';
  try {
    const res = await fetch('/api/checkout', { method: 'POST' });
    const body = await res.json();
    if (res.ok && body.status === 'confirmed') {
      result.className = 'ok';
      result.textContent = `Order ${body.orderId} confirmed. Arrives in ${body.eta}.`;
    } else {
      result.className = 'error';
      result.textContent = 'Checkout failed. Please try again.';
    }
  } catch {
    result.className = 'error';
    result.textContent = 'Checkout failed. Please try again.';
  }
});

load();
