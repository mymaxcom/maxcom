// The monthly report drawn as an A4 sheet, from the same MonthReport the box
// turns into the PDF (apps/box-server/src/finance/pdf.ts). Same order and
// words: the surau and its address, "Penyata Kewangan Bulanan" with the
// month and the status line, 1. Ringkasan tabung, 2. Kutipan, 3. Bayaran,
// 4. Pembetulan, 5. Tandatangan, the footer "Dijana oleh MAXCOM ..." and the
// grey DRAF stamp until the month is Muktamad. Like the PDF it is Bahasa
// Malaysia whatever the app language. Drawn 595 points wide (A4) so the
// screen scales it to the width it has; the PDF's page breaks are not
// drawn, the sheet runs on.

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../finance/finance_models.dart';
import '../../finance/ledger.dart';

const double a4Width = 595.28;
const double a4Height = 841.89;
const double _margin = 51.02; // 18 mm

const List<String> _months = [
  'Januari',
  'Februari',
  'Mac',
  'April',
  'Mei',
  'Jun',
  'Julai',
  'Ogos',
  'September',
  'Oktober',
  'November',
  'Disember',
];

/// `2026-10` -> `Oktober 2026`.
String monthNameMs(String ym) {
  final m = int.tryParse(ym.length >= 7 ? ym.substring(5, 7) : '') ?? 0;
  final name = m >= 1 && m <= 12 ? _months[m - 1] : ym;
  return '$name ${ym.length >= 4 ? ym.substring(0, 4) : ''}'.trim();
}

/// `2026-10-02` -> `02/10/2026`.
String dmy(String d) => d.length >= 10
    ? '${d.substring(8, 10)}/${d.substring(5, 7)}/${d.substring(0, 4)}'
    : d;

/// An ISO instant as `dd/mm/yyyy HH:mm` on the Kuala Lumpur clock.
String klStamp(String iso) {
  final t = DateTime.tryParse(iso);
  if (t == null) return '';
  final k = t.toUtc().add(const Duration(hours: 8));
  String p(int n) => n.toString().padLeft(2, '0');
  return '${p(k.day)}/${p(k.month)}/${k.year} ${p(k.hour)}:${p(k.minute)}';
}

const Map<String, String> _kindMs = {
  'amount': 'Laras jumlah',
  'void': 'Batalkan catatan',
  'fund': 'Tukar tabung',
};

String _money(int sen) => formatRm(sen, parens: true);

class ReportA4 extends StatelessWidget {
  const ReportA4({
    super.key,
    required this.report,
    required this.surauName,
    this.shortAddress,
    this.closedAt,
    this.closedBy,
    this.fullPage = false,
  });

  final MonthReport report;
  final String surauName;
  final String? shortAddress;

  /// When the month was made Muktamad (ISO), and by whom when known.
  final String? closedAt;
  final String? closedBy;

  /// True: the whole sheet. False: the first A4 page only.
  final bool fullPage;

  bool get _draft => report.status != 'closed';

  @override
  Widget build(BuildContext context) {
    final sheet = _Sheet(this);
    return MediaQuery(
      // The sheet is a printed page: the phone's text size does not change it.
      data: MediaQuery.of(context).copyWith(textScaler: TextScaler.noScaling),
      child: ColoredBox(
        color: Colors.white,
        child: SizedBox(
          width: a4Width,
          child: fullPage
              ? ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: a4Height),
                  child: sheet,
                )
              : SizedBox(
                  height: a4Height,
                  child: ClipRect(
                    child: OverflowBox(
                      alignment: Alignment.topCenter,
                      minHeight: a4Height,
                      maxHeight: double.infinity,
                      child: sheet,
                    ),
                  ),
                ),
        ),
      ),
    );
  }
}

class _Sheet extends StatelessWidget {
  const _Sheet(this.a);

  final ReportA4 a;

  static const TextStyle _base = TextStyle(
    fontFamily: SurauTheme.fontFamily,
    color: Colors.black,
    fontSize: 9,
    height: 1.25,
    fontWeight: FontWeight.w400,
    fontFeatures: [FontFeature.tabularFigures()],
  );

  TextStyle _b(double size, {double? gray}) => _base.copyWith(
    fontSize: size,
    fontWeight: FontWeight.w700,
    color: gray == null ? Colors.black : Colors.black.withValues(alpha: gray),
  );

  @override
  Widget build(BuildContext context) {
    final r = a.report;
    final fundName = {for (final f in r.funds) f.fundId: f.name};
    final month = monthNameMs(r.ym);
    final status = a._draft
        ? 'DRAF: belum dimuktamadkan'
        : 'MUKTAMAD${a.closedAt != null ? ', ditutup ${dmy(a.closedAt!.length >= 10 ? a.closedAt! : '')}' : ''}'
              '${a.closedBy != null && a.closedBy!.isNotEmpty ? ' oleh ${a.closedBy}' : ''}';
    final made = klStamp(r.generatedAt);
    final synced = r.syncedUntil == null ? '' : klStamp(r.syncedUntil!);

    final body = Container(
      key: const Key('finr-a4'),
      padding: const EdgeInsets.fromLTRB(_margin, _margin, _margin, 72),
      child: DefaultTextStyle(
        style: _base,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(a.surauName, style: _b(15)),
            if (a.shortAddress != null && a.shortAddress!.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(a.shortAddress!),
              ),
            const SizedBox(height: 6),
            Row(
              children: [
                Expanded(
                  child: Text('Penyata Kewangan Bulanan', style: _b(13)),
                ),
                Text(month, style: _b(13)),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              status,
              key: const Key('finr-a4-status'),
              style: _b(9, gray: a._draft ? 0.65 : 1),
            ),
            const Divider(color: Colors.black, thickness: 1, height: 14),
            _section('1. Ringkasan tabung'),
            _summary(r),
            ..._groups('2. Kutipan mengikut tabung dan perihal', [
              for (final g in r.inByPerihal)
                _GroupView(g.label, fundName[g.fundId] ?? '', g.totalSen, [
                  for (final x in g.rows)
                    _RowView(x.date, x.refNo, x.note ?? '', x.amountSen),
                ]),
            ]),
            ..._groups('3. Bayaran mengikut perihal', [
              for (final g in r.outByPerihal)
                _GroupView(g.label, fundName[g.fundId] ?? '', g.totalSen, [
                  for (final x in g.rows)
                    _RowView(x.date, x.refNo, _outDesc(x), x.amountSen),
                ]),
            ]),
            _section('4. Pembetulan'),
            if (r.corrections.isEmpty)
              _none('Tiada pembetulan bulan ini.')
            else
              _corrections(r),
            _section('5. Tandatangan'),
            const SizedBox(height: 22),
            Row(
              children: [
                for (var i = 0; i < 3; i++) ...[
                  if (i > 0) const SizedBox(width: 20),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Divider(
                          color: Colors.black,
                          thickness: 0.5,
                          height: 1,
                        ),
                        const SizedBox(height: 4),
                        Text(['Bendahari', 'Pengerusi', 'Tarikh'][i]),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
    // At the foot of the page, like the PDF's: on white, so a long first
    // page ends there as the printed one does.
    final footer = ColoredBox(
      color: Colors.white,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(_margin, 0, _margin, 0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Divider(color: Colors.black, thickness: 0.4, height: 1),
            const SizedBox(height: 4),
            Text(
              'Dijana oleh MAXCOM $made${synced.isNotEmpty ? ', Diselaraskan sehingga $synced' : ''}',
              key: const Key('finr-a4-footer'),
              style: _base.copyWith(
                fontSize: 7.5,
                color: Colors.black.withValues(alpha: 0.7),
              ),
            ),
          ],
        ),
      ),
    );
    return Stack(
      children: [
        // The stamp sits behind the figures, like the PDF's.
        if (a._draft)
          Positioned.fill(
            child: IgnorePointer(
              child: Align(
                alignment: const Alignment(0, -0.2),
                child: Transform.rotate(
                  angle: -20 * math.pi / 180,
                  child: Text(
                    'DRAF',
                    key: const Key('finr-a4-stamp'),
                    style: TextStyle(
                      fontFamily: SurauTheme.fontFamily,
                      fontSize: 110,
                      fontWeight: FontWeight.w800,
                      color: Colors.black.withValues(alpha: 0.08),
                    ),
                  ),
                ),
              ),
            ),
          ),
        body,
        if (a.fullPage)
          Positioned(left: 0, right: 0, bottom: 36, child: footer)
        else
          Positioned(
            left: 0,
            right: 0,
            top: a4Height - 65,
            height: 65,
            child: footer,
          ),
      ],
    );
  }

  String _outDesc(ReportOutRow x) {
    final extra = x.penceramahName != null
        ? [
            x.penceramahName!,
            if (x.kuliahTitle != null)
              'kuliah ${x.kuliahDate != null ? dmy(x.kuliahDate!) : ''} ${x.kuliahTitle}'
                  .trim(),
          ].where((e) => e.isNotEmpty).join(', ')
        : (x.payee ?? '');
    return [extra, x.note ?? ''].where((e) => e.isNotEmpty).join(', ');
  }

  Widget _section(String title) => Padding(
    padding: const EdgeInsets.only(top: 10, bottom: 6),
    child: Text(title, style: _b(11)),
  );

  Widget _none(String t) => Padding(
    padding: const EdgeInsets.only(bottom: 4),
    child: Text(t, style: _base.copyWith(color: Colors.black54)),
  );

  Widget _summary(MonthReport r) {
    Widget row(String first, List<String> cells, {bool bold = false}) {
      final st = bold ? _b(9) : _base;
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 1),
        child: Row(
          children: [
            Expanded(child: Text(first, style: st)),
            for (final (i, c) in cells.indexed)
              SizedBox(
                // Right edges 88 points apart, the first column narrow, as
                // in pdf.ts.
                width: i == 0 ? 56 : 88,
                child: Text(c, style: st, textAlign: TextAlign.right),
              ),
          ],
        ),
      );
    }

    final t = r.totals;
    return Column(
      children: [
        row('Tabung', const [
          'Baki awal',
          'Kutipan',
          'Bayaran',
          'Pembetulan',
          'Baki akhir',
        ], bold: true),
        const Divider(color: Colors.black, thickness: 0.5, height: 3),
        for (final f in r.funds)
          row(f.name, [
            _money(f.openingSen),
            _money(f.inSen),
            _money(f.outSen),
            _money(f.correctionsSen),
            _money(f.closingSen),
          ]),
        const Divider(color: Colors.black, thickness: 0.5, height: 5),
        row('Jumlah', [
          _money(t.openingSen),
          _money(t.inSen),
          _money(t.outSen),
          _money(t.correctionsSen),
          _money(t.closingSen),
        ], bold: true),
      ],
    );
  }

  List<Widget> _groups(String title, List<_GroupView> groups) {
    return [
      _section(title),
      if (groups.isEmpty) _none('Tiada catatan.'),
      for (final g in groups)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('${g.label}, ${g.fund}', style: _b(9.5)),
              const SizedBox(height: 3),
              for (final x in g.rows) _entryRow(x.date, x.ref, x.desc, x.sen),
              const SizedBox(height: 2),
              const Align(
                alignment: Alignment.centerRight,
                child: SizedBox(
                  width: 110,
                  child: Divider(
                    color: Colors.black,
                    thickness: 0.4,
                    height: 1,
                  ),
                ),
              ),
              const SizedBox(height: 3),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  Text('Jumlah', style: _b(9)),
                  SizedBox(
                    width: 118,
                    child: Text(
                      _money(g.total),
                      style: _b(9),
                      textAlign: TextAlign.right,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
    ];
  }

  Widget _entryRow(String date, String? ref, String desc, int sen) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 0.75),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(width: 4),
        SizedBox(
          width: 58,
          child: Text(dmy(date), style: _base.copyWith(fontSize: 8.5)),
        ),
        SizedBox(
          width: 50,
          child: Text(ref ?? '', style: _base.copyWith(fontSize: 8.5)),
        ),
        Expanded(child: Text(desc, style: _base.copyWith(fontSize: 8.5))),
        const SizedBox(width: 8),
        SizedBox(
          width: 100,
          child: Text(
            _money(sen),
            textAlign: TextAlign.right,
            style: _base.copyWith(fontSize: 8.5),
          ),
        ),
      ],
    ),
  );

  Widget _corrections(MonthReport r) {
    return Column(
      children: [
        Row(
          children: [
            const SizedBox(width: 4),
            SizedBox(width: 58, child: Text('Tarikh', style: _b(8.5))),
            SizedBox(width: 50, child: Text('No.', style: _b(8.5))),
            Expanded(child: Text('Catatan asal, jenis, sebab', style: _b(8.5))),
            const SizedBox(width: 8),
            SizedBox(
              width: 100,
              child: Text('Kesan', style: _b(8.5), textAlign: TextAlign.right),
            ),
          ],
        ),
        const Divider(color: Colors.black, thickness: 0.5, height: 5),
        for (final c in r.corrections)
          _entryRow(
            c.date,
            c.refNo,
            '${c.originalRefNo ?? ''} ${_kindMs[c.kind] ?? c.kind}${c.lastMonth ? ' (bulan lepas)' : ''}: ${c.reason}'
                .trim(),
            c.deltaSen,
          ),
      ],
    );
  }
}

class _GroupView {
  const _GroupView(this.label, this.fund, this.total, this.rows);

  final String label;
  final String fund;
  final int total;
  final List<_RowView> rows;
}

class _RowView {
  const _RowView(this.date, this.ref, this.desc, this.sen);

  final String date;
  final String? ref;
  final String desc;
  final int sen;
}
