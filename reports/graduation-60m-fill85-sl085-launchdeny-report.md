# 60 dk kağıt — fill %85–97, SL 0,85, launch kara liste

SIMULATION_ONLY. UTC+3 **16:58:23 → 17:58:24**. Commit `35e32ac`.  
A/B: tiered 1.2/1.6 vs TP 1.4. Creator denylist **26** (4 eski + 22 launch).

## Kapanmış

| | Tiered | Simple |
|--|--------|--------|
| Trade | 46 | 46 |
| W / L | 22 / 24 | 23 / 23 |
| PnL | **+0,0719 SOL** | **+0,0571 SOL** |
| Açık | 0 | 0 |

Çift: 27 berabere · tiered 10 önde · simple 9 önde.

**Simple:** SL 21 (%46) · TP 1,4 **17 (%37)** · timeout 8 (%17)

## Kara liste işledi mi?

Evet, sınırlı: **26 skip satırı, 13 farklı mint, 4 creator** (`6wjhFZ3w` 15 tick, `K6Eh9fwK` 6, `61sZ9zry` 3, `88md4Q8b` 2).  
Oturum içi `creator_session_sl`: 9 satır.

Çoğu skip hâlâ fill≥97, cold start, velocity — kara liste tek başına hacmi kesmedi.

## Fill dilimi (simple)

| Dilim | n | SL | TP |
|-------|---|----|----|
| %85–88 | 18 | 7 | 8 |
| %88–92 | 12 | 7 | 2 |
| %92–95 | 9 | 3 | 4 |
| %95–97 | 7 | 4 | 3 |

WS: **36** hata / 60 dk.

Bu pencere hafif artı; önceki fill85 3×30 ve fill80 2×30 ile **nedensel kıyas yok**.
