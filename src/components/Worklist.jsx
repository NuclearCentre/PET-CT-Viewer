// components/Worklist.jsx
//
// Real Orthanc-backed (or any DICOMweb-compliant PACS) study list, plus a
// file picker / drag-drop area for uploading local DICOM files.
//
// STUDY LIST: QIDO-RS  GET {dicomWebRestBase}/studies
//   Standard DICOMweb -- works with Orthanc, DCM4CHEE, Google Cloud Healthcare,
//   AWS HealthImaging, Azure DICOM Service, and any DICOM PS3.18-compliant PACS.
//
// UPLOAD: STOW-RS  POST {dicomWebRestBase}/studies
//   Standard DICOMweb (DICOM PS3.18 Section 10.5) -- multipart/related body,
//   one part per DICOM instance. This replaces the previous Orthanc-native
//   REST endpoint (POST /instances) which was proprietary and non-portable.
//   STOW-RS is supported by all major PACS systems listed above.
//
//   After upload, the DICOM StudyInstanceUID is extracted directly from the
//   STOW-RS response (ReferencedSOPSequence - ReferencedStudySequence) rather
//   than via a follow-up Orthanc-specific GET /studies/{internalId} call,
//   making study auto-selection fully PACS-agnostic too.

import { useState, useEffect, useCallback, useRef } from 'react';
import { getDicomWebRestBase } from './ViewportGrid.jsx';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function _name(v) {
  if (!v) return 'Unknown';
  const raw = (typeof v === 'object' && v.Alphabetic) ? v.Alphabetic : String(v);
  return raw.replace(/\^/g, ' ').trim() || 'Unknown';
}

function _fmtDate(d) {
  if (!d || String(d).length < 8) return '—';
  const s = String(d);
  const mIdx = parseInt(s.slice(4, 6), 10) - 1;
  return `${s.slice(6, 8)} ${MONTHS[mIdx] || ''} ${s.slice(0, 4)}`;
}

async function _fetchStudies() {
  const restBase = getDicomWebRestBase();
  const res = await fetch(`${restBase}/studies`);
  if (!res.ok) throw new Error(`Study list failed: ${res.status} (${restBase}/studies)`);
  const json = await res.json();
  return (json || [])
    .map(s => ({
      studyUID:    s['0020000D']?.Value?.[0] || '',
      patientName: _name(s['00100010']?.Value?.[0]),
      date:        s['00080020']?.Value?.[0] || '',
      dateLabel:   _fmtDate(s['00080020']?.Value?.[0]),
      modalities:  (s['00080061']?.Value || []).join('/') || (s['00080060']?.Value?.[0] || '—'),
      desc:        s['00081030']?.Value?.[0] || '',
    }))
    .filter(s => s.studyUID)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}


// ---- Local DICOM helpers ----

function _installLocalLoader() {
  if (window.__localLoaderInstalled) return;
  window.__localLoaderInstalled = true;
  const origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : (input?.url || '');
    if (url.startsWith('blob:') && window.__localDicomFiles?.has(url)) {
      const buf = window.__localDicomFiles.get(url);
      return Promise.resolve(new Response(buf, {
        status: 200,
        headers: { 'Content-Type': 'application/dicom' },
      }));
    }
    return origFetch(input, init);
  };
}

function _readDicomTag(bytes, group, element) {
  try {
    let offset = 132; // skip preamble + DICM magic
    const view = new DataView(bytes.buffer);
    while (offset + 8 < bytes.length) {
      const g = view.getUint16(offset,     true);
      const e = view.getUint16(offset + 2, true);
      offset += 4;
      const vr = String.fromCharCode(bytes[offset], bytes[offset + 1]);
      let len, dataStart;
      const longVRs = ['OB','OW','SQ','UN','UC','UR','UT'];
      if (/^[A-Z]{2}$/.test(vr) && !longVRs.includes(vr)) {
        len = view.getUint16(offset + 2, true);
        dataStart = offset + 4;
      } else if (longVRs.includes(vr)) {
        len = view.getUint32(offset + 4, true);
        dataStart = offset + 8;
      } else {
        len = view.getUint32(offset, true);
        dataStart = offset + 4;
      }
      if (len === 0xFFFFFFFF || len < 0) break;
      if (g === group && e === element) {
        return new TextDecoder().decode(bytes.slice(dataStart, dataStart + len))
          .replace(/\0/g, '').trim();
      }
      offset = dataStart + Math.max(0, len);
      if (offset > bytes.length) break;
    }
  } catch(e) {}
  return null;
}

export default function Worklist({ activeStudyUID, onSelectStudy }) {
  const [studies,  setStudies]  = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);
  const [filter,   setFilter]   = useState('');
  const [uploading, setUploading]   = useState(false);
  const [progress,  setProgress]    = useState(null); // { done, total }
  const [dragOver,  setDragOver]    = useState(false);
  const fileInputRef = useRef(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await _fetchStudies();
      setStudies(list);
    } catch (e) {
      setError(e?.message || 'Failed to load studies');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []).filter(f => f && f.size > 0);
    if (!files.length) return;

    setUploading(true);
    setProgress({ done: 0, total: files.length });

    // LOCAL FILE LOAD: read DICOM files directly from the local filesystem.
    // Parse StudyInstanceUID from raw DICOM bytes, register each file under
    // an Object URL, and expose them via window.__localDicomFiles so CS3D's
    // wadouri loader (patched by _installLocalLoader below) can serve them.
    // No PACS/Orthanc round-trip required -- works offline.
    if (!window.__localDicomFiles) window.__localDicomFiles = new Map();
    _installLocalLoader();

    let lastStudyUID = null;
    const localImageIds = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const studyUID = _readDicomTag(bytes, 0x0020, 0x000D);
        if (studyUID && !lastStudyUID) lastStudyUID = studyUID;
        const url = URL.createObjectURL(file);
        window.__localDicomFiles.set(url, buf);
        localImageIds.push('wadouri:' + url);
      } catch(e) {
        console.warn('[Worklist] local file read error:', e?.message);
      }
      setProgress({ done: i + 1, total: files.length });
    }

    setUploading(false);
    setProgress(null);

    if (lastStudyUID && localImageIds.length) {
      if (!window.__localStudyImageIds) window.__localStudyImageIds = {};
      window.__localStudyImageIds[lastStudyUID] = localImageIds;
      onSelectStudy?.(lastStudyUID, {
        studyUID: lastStudyUID,
        patientName: 'Local file',
        dateLabel: new Date().toLocaleDateString(),
        modalities: 'LOCAL',
        desc: files.length + ' file(s) from system',
        local: true,
        localImageIds,
      });
    } else if (!localImageIds.length) {
      alert('No valid DICOM files found.');
    }
  }, [refresh, onSelectStudy]);


  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer?.files);
  }, [handleFiles]);

  const visibleStudies = filter
    ? studies.filter(s =>
        s.patientName.toLowerCase().includes(filter.toLowerCase()) ||
        s.desc.toLowerCase().includes(filter.toLowerCase()))
    : studies;

  return (
    <div>
      {/* Upload area */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{
          padding: '8px 6px', marginBottom: 6, borderRadius: 4, textAlign: 'center',
          cursor: uploading ? 'default' : 'pointer',
          background: dragOver ? '#eaf2ff' : '#f8f8f8',
          border: `1.5px dashed ${dragOver ? '#6699cc' : '#ccc'}`,
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".dcm,application/dicom,*/*"
          style={{ display: 'none' }}
          onChange={e => { handleFiles(e.target.files); e.target.value = ''; }}
        />
        {uploading ? (
          <div style={{ fontSize: 8, color: '#336699' }}>
            Uploading {progress?.done ?? 0}/{progress?.total ?? 0}…
          </div>
        ) : (
          <div style={{ fontSize: 8, color: '#666' }}>
            ⇪ Drop DICOM files here, or click to choose
            <div style={{ fontSize: 7, color: '#999', marginTop: 2 }}>
              .dcm files — one study's instances at a time
            </div>
          </div>
        )}
      </div>

      {/* Search + refresh */}
      <div style={{ display: 'flex', gap: 3, marginBottom: 5 }}>
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="🔍 Search patient/desc…"
          style={{
            flex: 1, padding: '3px 5px', background: '#fff', border: '1px solid #ccc',
            borderRadius: 3, fontSize: 8, color: '#333', outline: 'none',
          }}
        />
        <div
          onClick={refresh}
          title="Refresh"
          style={{
            padding: '3px 7px', background: '#f0f4ff', border: '1px solid #99aacc',
            borderRadius: 3, fontSize: 10, cursor: 'pointer', color: '#336699',
          }}
        >
          {loading ? '…' : '⟳'}
        </div>
      </div>

      {error && (
        <div style={{ fontSize: 7, color: '#aa3333', marginBottom: 5, lineHeight: 1.4 }}>
          {error}
        </div>
      )}

      {!error && !loading && visibleStudies.length === 0 && (
        <div style={{ fontSize: 7, color: '#999' }}>No studies found.</div>
      )}

      {visibleStudies.map(s => {
        const active = s.studyUID === activeStudyUID;
        return (
          <div
            key={s.studyUID}
            onClick={() => onSelectStudy?.(s.studyUID, s)}
            style={{
              padding: '3px 5px', marginBottom: 2, borderRadius: 3, cursor: 'pointer',
              background: active ? '#dde8f8' : '#f8f8f8',
              border: `1px solid ${active ? '#99aacc' : '#ddd'}`,
            }}
          >
            <div style={{ fontSize: 8, color: active ? '#0c447c' : '#222', fontWeight: active ? 'bold' : 'normal' }}>
              {s.patientName}
            </div>
            <div style={{ fontSize: 7, color: active ? '#185fa5' : '#888' }}>
              {s.dateLabel} · {s.modalities}{s.desc ? ` · ${s.desc}` : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}