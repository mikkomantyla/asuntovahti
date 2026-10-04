# Asuntovahti

Hakee kerran päivässä pääkaupunkiseudun myytävät asunnot [Oikotieltä](https://asunnot.oikotie.fi) ja näyttää hakuehtoihin sopivat kohteet. Uudet kohteet korostetaan, ja kohteita voi tallentaa tai hylätä.

## Miten se toimii

- `crawler/crawl.mjs` – Node-skripti, joka hakee kohteet Oikotien hakurajapinnasta ja kirjoittaa ne tiedostoon `data/listings.json`. Jokaiselle kohteelle tallennetaan päivä, jolloin se nähtiin ensimmäisen kerran.
- `.github/workflows/crawl.yml` – GitHub Actions ajaa skriptin kerran päivässä ja commitoi päivittyneen datan.
- `index.html`, `app.js`, `style.css` – staattinen käyttöliittymä GitHub Pagesissa. Hakuehdot (postinumero, hinta, pinta-ala, rakennusvuosi, huoneet, tontti, talotyyppi) suodatetaan selaimessa.
- Hakuehdot sekä tallennetut ja hylätyt kohteet säilyvät selaimen localStoragessa. **Kopioi linkki** siirtää ne toiselle laitteelle.

## Ajo omalla koneella

```bash
node crawler/crawl.mjs
python3 -m http.server 8000
```

Oikotiellä ei ole virallista julkista rajapintaa, joten haku käyttää samaa rajapintaa kuin Oikotien oma hakusivu ja voi rikkoutua, jos sivusto muuttuu. Tarkoitettu henkilökohtaiseen käyttöön.
