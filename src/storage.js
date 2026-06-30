// IndexedDB persistence via localforage

let store;

function getStore() {
  if (!store) {
    store = localforage.createInstance({ name: 'miditrain', storeName: 'compositions' });
  }
  return store;
}

export async function saveComposition(composition) {
  const id = composition.id || crypto.randomUUID();
  const data = { ...composition, id, updatedAt: Date.now(), createdAt: composition.createdAt || Date.now() };
  await getStore().setItem(id, data);
  return data;
}

export async function loadComposition(id) {
  return getStore().getItem(id);
}

export async function listCompositions() {
  const items = [];
  await getStore().iterate(value => { items.push(value); });
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteComposition(id) {
  await getStore().removeItem(id);
}
