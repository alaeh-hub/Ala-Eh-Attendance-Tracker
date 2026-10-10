import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";

export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";
export const SOCKET_URL = API_URL.replace(/\/api\/?$/, "");

export const api = axios.create({ baseURL: API_URL });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("access_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Transparently refresh an expired access token once, so a kiosk left
// running all day doesn't get bounced to the login screen.
let refreshing: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const refresh = localStorage.getItem("refresh_token");
  if (!refresh) return null;
  try {
    const res = await axios.post(`${API_URL}/auth/refresh`, null, {
      headers: { Authorization: `Bearer ${refresh}` },
    });
    localStorage.setItem("access_token", res.data.access_token);
    return res.data.access_token as string;
  } catch {
    return null;
  }
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError<any>) => {
    const original = error.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
    const isAuthCall = original?.url?.includes("/auth/login") || original?.url?.includes("/auth/refresh");
    if (error.response?.status === 401 && original && !original._retried && !isAuthCall) {
      original._retried = true;
      refreshing = refreshing ?? refreshAccessToken().finally(() => (refreshing = null));
      const token = await refreshing;
      if (token) {
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      }
      window.dispatchEvent(new Event("auth:expired"));
    }
    return Promise.reject(error);
  }
);

export function errorMessage(err: unknown, fallback = "Something went wrong."): string {
  const e = err as AxiosError<any>;
  if (!e?.response) return "Can't reach the server. Check the connection.";
  return e.response.data?.error || fallback;
}

export async function downloadFile(url: string, params: Record<string, string | undefined>, fallbackName: string) {
  const res = await api.get(url, { params, responseType: "blob" });
  const disposition = res.headers["content-disposition"] as string | undefined;
  const name = disposition?.match(/filename="?([^"]+)"?/)?.[1] || fallbackName;
  const href = URL.createObjectURL(res.data);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export default api;
