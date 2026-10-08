// ---------------------------------------------------------------- PDF export
// "Download PDF" saves the open conversation as it looks on screen, charts
// included. Each question and answer is captured with html2canvas and placed
// on A4 pages with jsPDF; an answer moves to the next page rather than being
// split, unless it is taller than a page. Both libraries load on first use.

const PDF_LIBS = [
  'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
  'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

/** jsPDF's built-in fonts only cover Latin-1; header text is drawn as text, so keep it to that. */
function pdfSafe(s) {
  return String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/[^\x20-\xFF]/g, '').trim();
}

const PRODUCT = 'Lens MLOps';

/** The Concentrix logo from the page header as a PNG (null if it isn't installed), for the PDF's first page. */
function logoImage() {
  const img = document.querySelector('.cnx-logo');
  if (!img || !img.complete || !img.naturalWidth) return null;
  const c = document.createElement('canvas');
  const h = 96;
  c.height = h;
  c.width = Math.round(img.naturalWidth * (h / img.naturalHeight));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  try { return { data: c.toDataURL('image/png'), ratio: c.width / c.height }; } catch { return null; }
}

async function downloadSessionPdf() {
  const btn = document.getElementById('pdfBtn');
  const label = document.getElementById('pdfBtnLabel');
  const rows = [...msgsEl.querySelectorAll('.turnrow')].filter(r => !r.querySelector('.thinking'));
  if (!rows.length || btn.disabled) return;
  btn.disabled = true;
  label.textContent = 'Preparing…';
  try {
    for (const src of PDF_LIBS) await loadScript(src);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const W = pdf.internal.pageSize.getWidth();
    const H = pdf.internal.pageSize.getHeight();
    const M = 12;                 // side margin
    const TOP = 14, BOTTOM = 14;  // room for the running header / page number
    const GAP = 4;                // space between turns

    // Same proportions as on screen: the message column maps to the page width.
    const colStyle = getComputedStyle(msgsEl);
    const colPx = msgsEl.clientWidth - parseFloat(colStyle.paddingLeft) - parseFloat(colStyle.paddingRight);
    const mmPerPx = (W - 2 * M) / colPx;

    // First-page heading: Concentrix logo (or name), the product, and what this export is.
    // The session name is left out on purpose: it comes from a user's question.
    const logo = logoImage();
    if (logo) pdf.addImage(logo.data, 'PNG', M, M - 3, 7 * logo.ratio, 7);
    else {
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10); pdf.setTextColor(15, 23, 42);
      pdf.text('CONCENTRIX', M, M + 2);
    }
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(16); pdf.setTextColor(15, 23, 42);
    pdf.text(PRODUCT, M, M + 13);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(100, 116, 139);
    const questions = msgsEl.querySelectorAll('.turnrow.user').length;
    const subtitleY = M + 19;
    pdf.text(pdfSafe(`Conversation export - ${questions} question${questions === 1 ? '' : 's'} - ${new Date().toLocaleString()}`), M, subtitleY);
    pdf.setDrawColor(229, 232, 237); pdf.line(M, subtitleY + 4, W - M, subtitleY + 4);
    let y = subtitleY + 9;

    const newPage = () => { pdf.addPage(); y = TOP + 4; };

    for (let i = 0; i < rows.length; i++) {
      label.textContent = `Preparing… ${i + 1}/${rows.length}`;
      const row = rows[i];
      const canvas = await html2canvas(row, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false,
        onclone: (doc) => {
          doc.body.classList.add('pdf-export');
          // html2canvas draws a closed <details> with its hidden content showing;
          // replace it with the one-line summary the user actually sees.
          doc.querySelectorAll('details:not([open])').forEach(d => {
            const line = doc.createElement('div');
            line.className = 'steps steps-closed';
            line.textContent = '▸ ' + (d.querySelector('summary')?.textContent || '').trim();
            d.replaceWith(line);
          });
        },
      });
      const wMm = row.offsetWidth * mmPerPx;
      const hMm = (canvas.height / canvas.width) * wMm;
      const x = row.classList.contains('user') ? W - M - wMm : M;  // questions on the right, as in the app
      const room = H - BOTTOM - y;

      if (hMm <= room) {
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', x, y, wMm, hMm);
        y += hMm + GAP;
        continue;
      }
      if (hMm <= H - BOTTOM - TOP - 4 || room < 40) newPage();
      if (hMm <= H - BOTTOM - y) {
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', x, y, wMm, hMm);
        y += hMm + GAP;
        continue;
      }
      // Taller than a page: split it across pages, between blocks (paragraphs,
      // headings, lists, charts) so nothing is cut in half where avoidable.
      const pxPerMm = canvas.width / wMm;
      const cssToCanvas = canvas.height / row.offsetHeight;
      const rowTop = row.getBoundingClientRect().top;
      const breaks = [...row.querySelectorAll('.md > *, .steps, .meta')]
        .map(el => Math.round((el.getBoundingClientRect().top - rowTop) * cssToCanvas) - 6)
        .filter(b => b > 0)
        .sort((a, b) => a - b);
      let offsetPx = 0;
      while (offsetPx < canvas.height) {
        const limitPx = Math.floor((H - BOTTOM - y) * pxPerMm);
        let slicePx = canvas.height - offsetPx;
        if (slicePx > limitPx) {
          // The last block boundary that fits; only a block taller than a page is cut.
          const fit = breaks.filter(b => b > offsetPx + limitPx * 0.3 && b <= offsetPx + limitPx).pop();
          slicePx = fit ? fit - offsetPx : limitPx;
        }
        const part = document.createElement('canvas');
        part.width = canvas.width;
        part.height = slicePx;
        part.getContext('2d').drawImage(canvas, 0, offsetPx, canvas.width, slicePx, 0, 0, canvas.width, slicePx);
        pdf.addImage(part.toDataURL('image/jpeg', 0.92), 'JPEG', x, y, wMm, slicePx / pxPerMm);
        offsetPx += slicePx;
        y += slicePx / pxPerMm + GAP;
        if (offsetPx < canvas.height) newPage();
      }
    }

    // Running header (after page 1), footer and page numbers.
    const pages = pdf.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      pdf.setPage(p);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.setTextColor(100, 116, 139);
      if (p > 1) pdf.text(PRODUCT, M, 8);
      pdf.text(`Page ${p} of ${pages}`, W - M, H - 6, { align: 'right' });
      pdf.text(`Generated by Concentrix ${PRODUCT}`, M, H - 6);
    }

    const stamp = new Date().toISOString().slice(0, 10);
    pdf.save(`${PRODUCT} - ${stamp}.pdf`);
  } catch (err) {
    console.error(err);
    alert('Sorry, the PDF could not be created. Please try again.');
  } finally {
    btn.disabled = false;
    label.textContent = 'Download PDF';
  }
}

document.getElementById('pdfBtn').addEventListener('click', () => {
  if (typeof sending !== 'undefined' && sending) {
    alert('Please wait for the current answer to finish, then download.');
    return;
  }
  downloadSessionPdf();
});
