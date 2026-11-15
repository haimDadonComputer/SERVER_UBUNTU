import React from 'react';

export function ContentTabs({
    label,
    items,
    value,
    onChange,
}: {
    label: string;
    items: { id: string; label: string; count?: number }[];
    value: string;
    onChange: (value: string) => void;
}) {
    return (
        <div className="content-tabs" role="group" aria-label={label}>
            {items.map((item) => (
                <button
                    key={item.id}
                    type="button"
                    aria-pressed={value === item.id}
                    onClick={() => onChange(item.id)}
                >
                    {item.label}
                    {item.count !== undefined && <span>{item.count}</span>}
                </button>
            ))}
        </div>
    );
}
export function SummaryStrip({
    items,
}: {
    items: { label: string; value: React.ReactNode; icon: React.ReactNode }[];
}) {
    return (
        <div className="summary-strip">
            {items.map((item) => (
                <div key={item.label}>
                    <span className="summary-icon">{item.icon}</span>
                    <div>
                        <small>{item.label}</small>
                        <strong>{item.value}</strong>
                    </div>
                </div>
            ))}
        </div>
    );
}
