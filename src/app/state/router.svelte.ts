// Tiny hash router: #/view/param?query. Works on static hosting (GitHub Pages).
export type Route = { view: string; param: string; query: URLSearchParams };

function parse(): Route {
  const h = (typeof location !== 'undefined' ? location.hash : '').replace(/^#\/?/, '');
  const [path = '', qs = ''] = h.split('?');
  const [view = 'transactions', ...rest] = path.split('/');
  return { view: view || 'transactions', param: decodeURIComponent(rest.join('/')), query: new URLSearchParams(qs) };
}

class Router {
  route = $state<Route>(parse());
  constructor() {
    if (typeof window !== 'undefined') window.addEventListener('hashchange', () => (this.route = parse()));
  }
  go(view: string, param = '', query?: Record<string, string>) {
    const qs = query ? new URLSearchParams(query).toString() : '';
    location.hash = `#/${view}${param ? '/' + encodeURIComponent(param).replace(/%3A/gi, ':') : ''}${qs ? '?' + qs : ''}`;
  }
  back(fallback = 'transactions') {
    if (history.length > 1) history.back();
    else this.go(fallback);
  }
}

export const router = new Router();
export const href = (view: string, param = '') => `#/${view}${param ? '/' + encodeURIComponent(param).replace(/%3A/gi, ':') : ''}`;
