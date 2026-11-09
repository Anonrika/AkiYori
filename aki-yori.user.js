// ==UserScript==
// @name         AkiYori
// @description  Přidá na stránky akichan.moe záložku s titulky z Hiyori API.
// @namespace    https://github.com/Anonrika/AkiYori
// @homepageURL  https://github.com/Anonrika/AkiYori
// @supportURL   https://github.com/Anonrika/AkiYori/issues
// @updateURL    https://raw.githubusercontent.com/Anonrika/AkiYori/main/aki-yori.user.js
// @downloadURL  https://raw.githubusercontent.com/Anonrika/AkiYori/main/aki-yori.user.js
// @version      1.1
// @match        https://akichan.moe/anime/rozcestnik/*
// @include      /^https:\/\/akichan\.moe\/anime\/\d+\/*/
// @match        https://xn--l8jwa4d2g6c.xn--q9jyb4c/anime/rozcestnik/*
// @include      /^https:\/\/xn--l8jwa4d2g6c\.xn--q9jyb4c\/anime\/\d+\/*/
// @run-at       document-idle
// @grant        GM.xmlHttpRequest
// @grant        GM.registerMenuCommand
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      api.hiyori.cz
// ==/UserScript==

'use strict';

const API = 'https://api.hiyori.cz/v2';

// Požadavek na Hiyori API. Při HTTP chybě vyhodí Error s vlastností `status`.
function Api_pozadavek(method, url, {token, data, json = true} = {})
{
    const headers = {'Content-Type': 'application/json', 'Accept': 'application/json'};

    if (token)
    {
        headers['Authorization'] = 'Bearer ' + token;
    }

    return new Promise(function (resolve, reject)
    {
        GM.xmlHttpRequest({
            method,
            url,
            headers,
            data: data && JSON.stringify(data),
            timeout: 15000,

            onload(response)
            {
                if (response.status < 200 || response.status >= 300)
                {
                    const chyba = new Error(`HTTP ${response.status}`);
                    chyba.status = response.status;
                    reject(chyba);
                    return;
                }

                try
                {
                    resolve(json ? JSON.parse(response.responseText) : response.responseText);
                }
                catch (error)
                {
                    reject(error);
                }
            },

            onerror: () => reject(new Error('Chyba komunikace s API')),
            ontimeout: () => reject(new Error('API neodpovídá')),
        });
    });
}

// Vymění API klíč za token a uloží ho do sessionStorage.
async function Nacist_token()
{
    const api_klic = await GM.getValue('hiyori-api-key', '');

    if (!api_klic)
    {
        Upozornit_jednou('hiyori-api-upozorneni-chybejici-klic', 'Nemáš nastavený klíč na Hiyori API, bez něj se titulky nenačtou.');
        throw new Error('V nabídce rozšíření zvolte „Nastavit Hiyori API klíč“ a poté obnovte stránku.');
    }

    const odpoved = await Api_pozadavek('POST', `${API}/login/token`, {data: {api_key: api_klic}});
    const token = odpoved.data.token;

    sessionStorage.setItem('hiyori-api-token', token);

    return token;
}

// Spustí kód v kontextu stránky (kvůli jQuery, DataTables, tippy a <aki-chan>).
function Spustit_na_strance(kod)
{
    const script = document.createElement('script');

    script.textContent = kod;
    document.documentElement.appendChild(script);
    script.remove();
}

// Zobrazí hlášku Aki-chan, maximálně jednou za session.
function Upozornit_jednou(klic, text)
{
    if (sessionStorage.getItem(klic) === '1')
    {
        return;
    }

    sessionStorage.setItem(klic, '1');

    Spustit_na_strance(`const akichan = document.querySelector('aki-chan');
        akichan.setAttribute('bublina-barva', 'cervena');
        akichan.Zobraz_text(${JSON.stringify(text)});`);
}

// Přidá do rozcestníku anime panel „Titulky“ s prázdnou tabulkou a položku v podmenu.
function Pridat_zalozku_titulku()
{
    const panel = document.createElement('section');
    panel.id = 'titulky';
    panel.className = 'panel';
    panel.innerHTML = `
        <table id="tabulka-titulku" class="display responsive" style="table-layout: auto; font-size: 16px;">
            <thead>
                <tr>
                    <th>Epizoda</th>
                    <th>Název</th>
                    <th>Jazyk</th>
                    <th>Překlad</th>
                    <th>Release</th>
                    <th>Přidáno</th>
                    <th>Odkaz</th>
                </tr>
            </thead>
            <tbody></tbody>
        </table>
    `;

    document.querySelector('#stranka_rozcestniku').appendChild(panel);

    const odkaz = document.createElement('li');

    odkaz.setAttribute('data-id-panelu', 'titulky');
    odkaz.setAttribute('onclick', 'Ajax_nacteni_panelu(this); return false;');
    odkaz.textContent = 'Titulky';

    document.querySelector('.podmenu').appendChild(odkaz);
}

// Běží v kontextu stránky (vkládá se přes toString), nesmí tedy používat nic z vnějšku.
// Data si žádá přes událost `akichan:titulky:request` a dostává je zpět přes `akichan:titulky:response`.
function Inicializovat_tabulku()
{
    if (!window.jQuery || !jQuery.fn.DataTable)
    {
        console.warn('DataTables není na stránce dostupné.');
        return;
    }

    const cekajici_zadosti = new Map();
    const id_instance = Date.now() + ':' + Math.random();
    let id_zadosti = 0;

    const Escape = (hodnota) => String(hodnota ?? '').replace(/[&<>"']/g, (znak) => `&#${znak.charCodeAt(0)};`);

    function Nacist_stranku_tabulky_titulku(zadost, callback)
    {
        const id = id_instance + ':' + (++id_zadosti);
        const pageSize = zadost.length;
        const page = Math.floor(zadost.start / pageSize) + 1;

        // Callback musí být uložen ještě před odesláním události.
        cekajici_zadosti.set(id, callback);
        document.dispatchEvent(new CustomEvent('akichan:titulky:request', {
            detail: JSON.stringify({requestId: id, draw: zadost.draw, page, pageSize})
        }));
    }

    function Aktualizovat_data_tabulky_titulku(event)
    {
        const response = JSON.parse(event.detail);
        const callback = cekajici_zadosti.get(response.requestId);
        if (!callback)
        {
            return;
        }

        cekajici_zadosti.delete(response.requestId);

        let zprava = document.getElementById('chyba-titulku');
        if (response.error)
        {
            if (!zprava)
            {
                zprava = document.createElement('p');
                zprava.id = 'chyba-titulku';
                document.querySelector('#titulky').appendChild(zprava);
            }
            zprava.textContent = 'Nepodařilo se načíst titulky: ' + response.error;
        }
        else if (zprava)
        {
            zprava.remove();
        }

        // DataTables by pole `error` zobrazilo přes alert(), chyba už je vypsaná v panelu.
        delete response.error;
        
        callback(response);
        tippy('[data-popis-titulku]',
        {
            allowHTML: true,
            appendTo: () => document.querySelector('main'),
            content: (reference) => reference.getAttribute('data-popis-titulku'),
        });
    }

    function Vykreslit_text(data, typ)
    {
        const hodnota = data == null ? '—' : String(data);
        return typ === 'display' ? `<div style="text-align: center">${Escape(hodnota)}</div>` : hodnota;
    }

    function Vykreslit_cislo_epizody(data)
    {
        return `<aki-flex justify-content="center"><span style="background: var(--hlavni-stredni); border-radius: 2px; padding: 2px 10px; color: white; font-weight: bold">${Escape(data)}</span></aki-flex>`;
    }

    function Vykreslit_nazev(data)
    {
        return `<div>${Escape(data)}</div>`;
    }

    function Vykreslit_jazyk(data, typ)
    {
        if (typ !== 'display')
        {
            return data || '—';
        }

        const kod = String(data || '').toUpperCase();
        const jazyky = {CZ: 'Čeština', EN: 'Angličtina', SK: 'Slovenština'};
        if (!jazyky[kod])
        {
            return Vykreslit_text(data, typ);
        }

        const vlajka = '/ikonky/vlajky/' + (kod === 'EN' ? 'gb' : kod.toLowerCase()) + '.svg';
        return `<aki-flex justify-content="center"><img src="${vlajka}" alt="${jazyky[kod]}" title="${jazyky[kod]}" style="display: block; height: 22px; width: auto; min-width: 28px;"></aki-flex>`;
    }

    function Vykreslit_preklad(data, typ, radek)
    {
        let detail = '';

        if (radek.translator)
        {
            detail += `<strong>Překlad: </strong> ${Escape(radek.translator)}<br>`;
        }

        if (radek.corrector)
        {
            detail += `<strong>Korektura: </strong> ${Escape(radek.corrector)}<br>`;
        }

        if (radek.version)
        {
            detail += `<strong>Verze: </strong> ${Escape(radek.version)}<br>`;
        }

        if (!data)
        {
            if (!radek.translator)
            {
                return '—';
            }
            return `<div data-popis-titulku="${Escape(detail)}" style="cursor: help; min-width: 100px; text-align: center">${Escape(radek.translator)}</div>`;
        }

        const id_fansubu = Escape(data);
        return `<a href="https://hiyori.cz/fansuby/${id_fansubu}" rel="noopener" target="_blank">
            <aki-flex justify-content="center" align-items="center" gap="10" style="cursor: help; min-width: 100px"
                data-popis-titulku="${Escape(detail)}">
                <img src="https://hiyori.cz/fansub-images/${id_fansubu}/logo.webp" alt=""
                onerror="this.onerror = null; this.src = 'https://hiyori.cz/Images/defaults/default-fansub-img.webp';"
                style="display: block; height: 28px; width: auto; min-width: 28px; border-radius: 100%;">
                <span>${Escape(radek.fansub?.name)}</span>
            </aki-flex>
        </a>`;
    }

    function Vykreslit_datum(data, typ)
    {
        const datum = data ? new Date(data) : null;
        if (!datum || Number.isNaN(datum.getTime()))
        {
            return typ === 'display' ? '—' : 0;
        }
        return typ === 'display' ? `<div style="text-align: center">${datum.toLocaleDateString('cs-CZ')}</div>` : datum.getTime();
    }

    // Titulky s externí URL dostanou odkaz „Přejít“, ostatní se stahují přes API (viz posluchač kliknutí v main()).
    function Vykreslit_odkaz(data, typ, radek)
    {
        if (typ !== 'display')
        {
            return data || '';
        }

        if (!data)
        {
            return `<div style="text-align: center"><a href="#" data-stahnout-titulky="${Escape(radek.id)}" data-pripona="${Escape(radek.format)}">Stáhnout</a></div>`;
        }

        try
        {
            const url = new URL(data, 'https://hiyori.cz/');
            if (!['http:', 'https:'].includes(url.protocol))
            {
                return '';
            }
            return `<div style="text-align: center"><a href="${Escape(url.href)}" target="_blank" rel="noopener">Přejít</a></div>`;
        }
        catch (error)
        {
            console.warn('Neplatná URL titulku:', data);
            return '';
        }
    }

    function Upravit_velikost_tabulky()
    {
        tabulka.columns.adjust();
        tabulka.responsive.recalc();
    }

    document.addEventListener('akichan:titulky:response', Aktualizovat_data_tabulky_titulku);

    const tabulka = jQuery('#tabulka-titulku').DataTable({
        responsive: {
            details: {
                display: jQuery.fn.dataTable.Responsive.display.modal(),
                renderer: jQuery.fn.dataTable.Responsive.renderer.tableAll()
            }
        },
        serverSide: true,
        processing: false,
        ajax: Nacist_stranku_tabulky_titulku,
        // API umí jen stránkování, hledání ani řazení na serveru nepodporuje.
        searching: false,
        ordering: false,
        scrollX: false,
        pageLength: 50,
        lengthMenu: [10, 25, 50],
        autoWidth: false,
        columns: [
            {data: 'episode', defaultContent: '—', render: Vykreslit_cislo_epizody, className: 'dt-nowrap', responsivePriority: 1},
            {data: 'title', defaultContent: '—', render: Vykreslit_nazev, responsivePriority: 4},
            {data: 'language', defaultContent: '—', render: Vykreslit_jazyk, responsivePriority: 3},
            {data: 'fansub_id', defaultContent: '—', render: Vykreslit_preklad, responsivePriority: 5},
            {data: 'release', defaultContent: '—', render: Vykreslit_text, responsivePriority: 6},
            {data: 'added_at', defaultContent: '—', render: Vykreslit_datum, className: 'dt-nowrap', responsivePriority: 8},
            {data: 'url', defaultContent: '', render: Vykreslit_odkaz, className: 'dt-nowrap', responsivePriority: 2}
        ],
        language: {
            lengthMenu: 'Zobrazit _MENU_ řádků',
            loadingRecords: 'Načítání...',
            processing: 'Zpracovávání...',
            info: 'Zobrazeno _START_ až _END_ z _TOTAL_ titulků',
            infoEmpty: 'Zobrazeno 0 řádků',
            emptyTable: 'Žádné titulky nejsou dostupné',
            zeroRecords: 'Žádné odpovídající titulky',
            paginate: {first: 'První', last: 'Poslední', next: 'Další', previous: 'Předchozí'}
        }
    });

    // Přímý odkaz na .../titulky rovnou otevře záložku.
    const zalozka = document.querySelector('[data-id-panelu="titulky"]');
    if (location.pathname.split('/').pop() === 'titulky' && zalozka)
    {
        Ajax_nacteni_panelu(zalozka, false);
    }

    jQuery(window).on('resize', Upravit_velikost_tabulky);
    jQuery(zalozka).on('click', Upravit_velikost_tabulky);
}

async function Nastavit_api_klic()
{
    const api_klic = prompt('Zadejte svůj Hiyori API klíč:');

    if (api_klic === null || !api_klic.trim())
    {
        return;
    }

    await GM.setValue('hiyori-api-key', api_klic.trim());

    sessionStorage.removeItem('hiyori-api-token');

    alert('Hiyori API klíč byl uložen. Obnovte stránku.');
}

async function main()
{
    GM.registerMenuCommand('Nastavit Hiyori API klíč', Nastavit_api_klic);

    // Akichan odkazuje na MyAnimeList, z odkazu vezmeme MAL ID anime.
    const mal_odkaz = document.querySelector('[href^="https://myanimelist.net/anime"]');
    const id_anime = mal_odkaz?.href.match(/\/anime\/(\d+)/)?.[1];

    if (!id_anime || !document.querySelector('#stranka_rozcestniku') || document.querySelector('#titulky'))
    {
        return;
    }

    let token = sessionStorage.getItem('hiyori-api-token') || await Nacist_token();

    // Zavolá API s tokenem, při 401 (propadlý token) si vyžádá nový a zkusí to znovu.
    async function S_tokenem(pozadavek)
    {
        try
        {
            return await pozadavek(token);
        }
        catch (error)
        {
            if (error.status !== 401)
            {
                throw error;
            }
            
            token = await Nacist_token();
            return await pozadavek(token);
        }
    }

    async function Nacist_stranku_titulku(event)
    {
        const request = JSON.parse(event.detail);
        const odpoved = {requestId: request.requestId, draw: request.draw, recordsTotal: 0, recordsFiltered: 0, data: []};

        try
        {
            const url = `${API}/subtitles/anime/mal/${id_anime}?page_size=${request.pageSize}&page=${request.page}`;
            const titulky = await S_tokenem((t) => Api_pozadavek('GET', url, {token: t}));

            const total = titulky.pagination?.total_items;
            if (!titulky.success || !Array.isArray(titulky.data) || !Number.isInteger(total) || total < 0)
            {
                throw new Error('API vrátilo neočekávanou odpověď.');
            }

            odpoved.recordsTotal = odpoved.recordsFiltered = total;
            odpoved.data = titulky.data;
            sessionStorage.removeItem('hiyori-api-upozorneni-429');
        }
        catch (error)
        {
            console.error('Načítání titulků selhalo:', error);

            odpoved.error = error.message;

            if (error.status === 429)
            {
                Upozornit_jednou('hiyori-api-upozorneni-429', 'Máš vyčerpaný limit volání na Hiyori. Zkus minutu počkat.');
            }
        }

        document.dispatchEvent(new CustomEvent('akichan:titulky:response', {detail: JSON.stringify(odpoved)}));
    }

    async function Stahnout_titulky(id_titulku, pripona)
    {
        const url = `${API}/subtitles/${id_titulku}/download`;
        const soubor = await S_tokenem((t) => Api_pozadavek('GET', url, {token: t, json: false}));

        const a = document.createElement('a');

        a.href = URL.createObjectURL(new Blob([soubor], {type: 'text/plain'}));
        a.download = `titulky-${id_titulku}.${pripona || 'srt'}`;

        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    document.addEventListener('click', function (event)
    {
        const odkaz = event.target.closest('[data-stahnout-titulky]');

        if (!odkaz)
        {
            return;
        }

        event.preventDefault();

        Stahnout_titulky(odkaz.dataset.stahnoutTitulky, odkaz.dataset.pripona).catch((error) => console.error('Stažení titulků selhalo:', error));
    });

    // Posluchač musí existovat před inicializací tabulky, která hned žádá první stránku.
    document.addEventListener('akichan:titulky:request', Nacist_stranku_titulku);
    Pridat_zalozku_titulku();
    Spustit_na_strance('(' + Inicializovat_tabulku.toString() + ')();');
}

main().catch(function (error)
{
    console.error('Skript pro načtení titulků selhal:', error);

    if (error.status === 403)
    {
        Upozornit_jednou('hiyori-api-upozorneni-403', 'Hiyori odmítla přístup k API, nejspíš máš chybný nebo propadlý API klíč. Zkus si to ověřit na svém profilu na Hiyori.');
    }
});
