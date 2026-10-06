import { useRef } from 'react';
import type { ApiKeyWrite } from './types.ts';

interface Props {
  id: string;
  credential: ApiKeyWrite;
  onChange: (value: string | null | undefined) => void;
  onReset: () => void;
}

export function ApiKeyField({ id, credential, onChange, onReset }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const removing = credential.apiKey === null;
  const replacing = typeof credential.apiKey === 'string';
  return <div className="api-key-field">
    <div className="field-heading"><label className="field-label" htmlFor={id}>API Key</label>
      <div className="credential-actions">
        {credential.hasApiKey && !replacing && !removing && <button type="button" className="text-button" onClick={() => inputRef.current?.focus()}>替换密钥</button>}
        {credential.hasApiKey && !removing && <button type="button" className="text-button" onClick={() => onChange(null)}>移除密钥</button>}
        {(replacing || removing) && <button type="button" className="text-button" onClick={onReset}>撤销密钥更改</button>}
      </div>
    </div>
    <input ref={inputRef} id={id} type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-describedby={`${id}-status`} placeholder={credential.hasApiKey && !removing ? '留空保留已保存的密钥' : '粘贴此服务的 API Key'} value={typeof credential.apiKey === 'string' ? credential.apiKey : ''} onChange={event => onChange(event.target.value)} />
    <p id={`${id}-status`} className="field-hint" role="status">{removing ? '保存后移除密钥；使用此密钥的当前模型将停用。' : replacing ? '新密钥尚未保存。保存后替换原有密钥。' : credential.hasApiKey ? '已保存密钥。留空保留，已保存的值不会显示。' : '尚未保存密钥。请直接填写 API Key。'}</p>
  </div>;
}
