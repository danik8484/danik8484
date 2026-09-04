import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PublicUser, Role } from "@shared/types";
import { api } from "../api";
import { useSession } from "../state";
import { Button, ErrorText, Field, Modal, Spinner, inputCls } from "../components/ui";
import { ROLE_LABEL } from "../format";

export default function Users() {
  const s = useSession();
  const [users, setUsers] = useState<PublicUser[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<PublicUser | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers((await api.users()).users);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-bold text-ink-900">משתמשים</h1>
        <Button onClick={() => setEditing("new")}>+ משתמש</Button>
      </div>
      <p className="mb-3 text-sm text-slate-600">כל עובד נכנס עם קוד שנשלח למייל שמוגדר כאן. עובד בלי מייל לא יכול להיכנס.</p>
      <ErrorText>{error}</ErrorText>
      {users === null ? (
        <Spinner />
      ) : (
        <ul className="space-y-2">
          {users.map((u) => (
            <li key={u.id} className={`flex items-center justify-between gap-2 rounded-2xl bg-white p-3 shadow-sm ${u.active ? "" : "opacity-60"}`}>
              <div className="min-w-0">
                <div className="text-sm font-bold text-ink-900">
                  {u.name} <span className="text-xs font-normal text-slate-500">· {ROLE_LABEL[u.role]}</span>
                  {!u.active && <span className="ms-2 text-xs font-semibold text-red-600">מושבת</span>}
                </div>
                <div className="truncate text-xs text-slate-500" dir="ltr">
                  {u.email ?? <span className="text-amber-700" dir="rtl">לא הוגדר מייל</span>}
                </div>
                {u.managerId && <div className="text-xs text-slate-500">מנהל: {s.nameOf(u.managerId)}</div>}
              </div>
              <Button variant="secondary" onClick={() => setEditing(u)}>
                עריכה
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "משתמש חדש" : "עריכת משתמש"}>
        {editing !== null && users && (
          <UserForm
            user={editing === "new" ? null : editing}
            all={users}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await load();
              await s.refresh();
            }}
          />
        )}
      </Modal>
    </div>
  );
}

function UserForm({ user, all, onCancel, onSaved }: { user: PublicUser | null; all: PublicUser[]; onCancel: () => void; onSaved: () => void }) {
  const s = useSession();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "employee");
  const [managerId, setManagerId] = useState<number | "">(user?.managerId ?? "");
  const [active, setActive] = useState(user?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const managers = all.filter((u) => u.active && u.role !== "employee" && u.id !== user?.id);
  const isSelf = user?.id === s.user.id;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = { name, email: email.trim() ? email.trim() : null, role, managerId: role === "admin" || managerId === "" ? null : Number(managerId) };
      if (user) await api.updateUser(user.id, { ...payload, active });
      else await api.createUser(payload);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="שם">
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
      </Field>
      <Field label="מייל לכניסה" hint="הקוד לכניסה נשלח לכתובת הזו">
        <input type="email" dir="ltr" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="תפקיד">
          <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={isSelf}>
            <option value="employee">עובד</option>
            <option value="manager">מנהל</option>
            <option value="admin">מנהל ראשי</option>
          </select>
        </Field>
        {role !== "admin" && (
          <Field label="מנהל ישיר">
            <select className={inputCls} value={managerId} onChange={(e) => setManagerId(e.target.value === "" ? "" : Number(e.target.value))} required>
              <option value="">בחר...</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <p className="text-xs text-slate-500">
        מנהל ראשי רואה את כולם. מנהל רואה את עצמו ואת העובדים שהוא המנהל הישיר שלהם. עובד רואה רק את עצמו.
      </p>
      {user && !isSelf && (
        <label className="flex items-center gap-2 text-sm font-semibold text-ink-700">
          <input type="checkbox" className="size-4 accent-brand-600" checked={active} onChange={(e) => setActive(e.target.checked)} />
          משתמש פעיל (משתמש מושבת לא יכול להיכנס)
        </label>
      )}
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>ביטול</Button>
        <Button type="submit" disabled={busy}>{busy ? "שומר..." : "שמירה"}</Button>
      </div>
    </form>
  );
}
