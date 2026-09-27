import { settings, type ConfigField, type SettingsContext } from '@bridgething/client/settings';
import { useEffect, useState, type FormEvent, type InputEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function fieldMeta(field: ConfigField): { key: string; label: string } {
  return { key: field.data.key, label: field.data.label };
}

function fieldDefault(field: ConfigField): string {
  const value = field.data.default;
  return value === null || value === undefined ? '' : String(value);
}

function Settings() {
  const [ctx, setCtx] = useState<SettingsContext | null>(null);
  const [fields, setFields] = useState<ConfigField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');

  useEffect(() => {
    (async () => {
      try {
        setCtx(await settings.context());
        const [schema, entries] = await Promise.all([settings.config.fields(), settings.config.list()]);
        setFields(schema);
        const stored = new Map(entries.map(entry => [entry.key, entry.value]));
        setValues(
          Object.fromEntries(schema.map(field => [field.data.key, stored.get(field.data.key) ?? fieldDefault(field)])),
        );
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  async function saveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus('saving...');
    try {
      for (const field of fields) {
        const { key } = fieldMeta(field);
        await settings.config.set(key, values[key] ?? '');
      }
      setStatus('settings saved');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main>
      <h1>{ctx?.name ?? 'bamcamthing'} settings</h1>
      <p className="hint">
        {ctx ? `${ctx.webappId} on ${ctx.deviceId}` : 'connecting to the companion host...'}
        <br />
        The stream token is on the Bambuddy Printers page, on the overlay url for the printer you want.
        <br />
        Bambuddy serves one camera reader at a time, so a feed open in OBS starves this app.
      </p>

      <form onSubmit={saveConfig}>
        {fields.length === 0 && <p className="hint">this webapp declares no config fields yet.</p>}
        {fields.map(field => {
          const { key, label } = fieldMeta(field);
          const value = values[key] ?? '';
          const onInput = (e: InputEvent<HTMLInputElement | HTMLSelectElement>) =>
            setValues({ ...values, [key]: (e.target as HTMLInputElement).value });
          if (field.type === 'boolean') {
            return (
              <div className="field row" key={key}>
                <input
                  id={key}
                  type="checkbox"
                  style={{ width: 18, height: 18 }}
                  checked={value === 'true'}
                  onChange={e =>
                    setValues({ ...values, [key]: (e.target as HTMLInputElement).checked ? 'true' : 'false' })
                  }
                />
                <label htmlFor={key}>{label}</label>
              </div>
            );
          }
          return (
            <div className="field" key={key}>
              <label htmlFor={key}>{label}</label>
              {field.type === 'enum' ? (
                <select id={key} value={value} onInput={onInput}>
                  {field.data.choices.map(choice => (
                    <option value={choice} key={choice}>
                      {choice}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={key}
                  type={field.type === 'number' ? 'number' : field.type === 'secret' ? 'password' : 'text'}
                  value={value}
                  onInput={onInput}
                />
              )}
            </div>
          );
        })}

        <div className="row">
          <button type="submit">Save settings</button>
          <button type="button" className="secondary" onClick={() => settings.done()}>
            Done
          </button>
        </div>
      </form>

      <p className="status">{status}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Settings />);
