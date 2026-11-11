# 3×30 dk kağıt — fill %85–97, SL 0,85, A/B çıkış

SIMULATION_ONLY. Aynı giriş; gölge çıkış: tiered 1.2/1.6 vs TP 1.4, **SL 0,85 her ikisinde**. Velocity zorunlu, creator filtresi açık. Commit `cc3c3c4`.

## Zaman (UTC+3)

| Run | Başlangıç | Bitiş |
|-----|-----------|-------|
| 1 | 18:49:56 | 19:19:56 |
| 2 | 19:19:57 | 19:50:08 |
| 3 | 19:50:09 | 20:20:09 |

## Oturum sonuçları (kapanmış PnL)

| Run | Tiered | Simple | W/L T | W/L S | AB çift | Çift: S / T / = | WS err | Açık |
|-----|--------|--------|-------|-------|---------|-----------------|--------|------|
| 1 | **−0,2726** | **−0,4244** | 10/21 | 9/22 | 31 | 6/7/18 | 50 | 0 |
| 2 | **+0,2706** | **+0,1868** | 12/15 | 13/16 | 27 | 5/8/14 | 33 | 3 |
| 3 | **+0,0101** | **+0,0079** | 9/13 | 9/14 | 22 | 6/4/12 | 40 | 2 |
| **Toplam** | **+0,0081** | **−0,2297** | 31/49 | 31/52 | 80 | 17/19/44 | 123 | — |

`+0,5664` birleşik satır yok; toplamlar **ayrı strateji**. Combined kullanma.

Açık pozisyonlar kapanmış PnL’ye **dahil değil** (run2 ~0,3 SOL, run3 ~0,2 SOL nominal).

## Aynı mint — simple çıkış sınıfı (80 çift)

| Sınıf | Adet | Pay |
|-------|------|-----|
| SL 0,85 öncesi | 47 | %59 |
| TP 1,4 tam | 24 | %30 |
| Timeout | 9 | %11 |

Tiered: SL öncesi 38 · tp1→tp2 21 · tp1 sonra SL/timeout 16 · timeout 5.

## Fill dilimi (simple SL/TP, çiftler)

| Dilim | n | SL | TP |
|-------|---|----|----|
| %85–88 | 30 | 17 | 13 |
| %88–92 | 29 | 17 | 6 |
| %92–95 | 10 | 7 | 3 |
| %95–97 | 11 | 6 | 2 |

%85–88 hâlâ karışık; yüksek dilimde TP seyrek (örnek az).

## Notlar

- Run 1 eksi, run 2 artı, run 3 ~sıfır — **aynı ayar, üç farklı pencere**.
- Creator skip: run1 **0**, run2 **7**, run3 **27** (denylist/session). Bu 90 dk’da kısmen işledi.
- WS **123** hata / 90 dk — veri kalitesi zayıf; önceki sabah A/B’de 30 dk’da 0 kopma vardı.
- Slip/Jito/PumpSwap/ücret yok.

Bu 3 koşu, 17:21’deki tek SL 0,85 oturumuyla (**+0,19 / +0,37**) **toplanmamalı** — o ayrı pencere.
