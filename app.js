// ============================================================
// Download GeoJSON
// ============================================================
async function downloadLayerAsGeoJSON(folder, file, layerName) {
    const url = `${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
    try {
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) throw new Error('Falha ao baixar');
        const data = await resp.json();
        const blob = new Blob([JSON.stringify(data)], { type: 'application/geo+json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${layerName.replace(/[^a-zA-Z0-9_\-]/g, '_')}.geojson`;
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (err) {
        alert(`Não foi possível baixar "${layerName}".`);
        console.error(err);
    }
}

// ============================================================
// Codificador WKB + Gerador de GeoPackage
// ============================================================
function encodeWKB(geometry) {
    const buf = [];
    const writeU8  = v => buf.push(v & 0xff);
    const writeU32 = v => buf.push(v&0xff,(v>>8)&0xff,(v>>16)&0xff,(v>>24)&0xff);
    function writeF64(v) {
        const dv = new DataView(new ArrayBuffer(8));
        dv.setFloat64(0, v, true);
        for (let i = 0; i < 8; i++) buf.push(dv.getUint8(i));
    }
    function writePt(c) { writeF64(c[0]); writeF64(c[1]); }

    function writeGeom(g) {
        if (!g) return;
        writeU8(1); // little-endian
        const typeMap = {Point:1,LineString:2,Polygon:3,MultiPoint:4,MultiLineString:5,MultiPolygon:6,GeometryCollection:7};
        writeU32(typeMap[g.type] || 0);
        const c = g.coordinates;
        if (g.type === 'Point')         { writePt(c); }
        else if (g.type === 'LineString')    { writeU32(c.length); c.forEach(writePt); }
        else if (g.type === 'Polygon')       { writeU32(c.length); c.forEach(r => { writeU32(r.length); r.forEach(writePt); }); }
        else if (g.type === 'MultiPoint')    { writeU32(c.length); c.forEach(pt => writeGeom({type:'Point',coordinates:pt})); }
        else if (g.type === 'MultiLineString'){ writeU32(c.length); c.forEach(ls => writeGeom({type:'LineString',coordinates:ls})); }
        else if (g.type === 'MultiPolygon')  { writeU32(c.length); c.forEach(p  => writeGeom({type:'Polygon',coordinates:p})); }
    }
    writeGeom(geometry);
    return new Uint8Array(buf);
}

function wrapGpkgGeom(wkb) {
    // GP header: magic(2) + version(1) + flags(1) + srs_id(4)
    const hdr = new Uint8Array([0x47,0x50, 0x00, 0x01, 0xE6,0x10,0x00,0x00]); // srs=4326 LE
    const out = new Uint8Array(hdr.length + wkb.length);
    out.set(hdr); out.set(wkb, hdr.length);
    return out;
}

let _sqlPromise = null;
function getSql() {
    if (!_sqlPromise) {
        _sqlPromise = initSqlJs({
            locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`
        });
    }
    return _sqlPromise;
}

async function downloadLayerAsGpkg(folder, file, layerName) {
    try {
        const [SQL, resp] = await Promise.all([
            getSql(),
            fetch(`${encodeURIComponent(folder)}/${encodeURIComponent(file)}`, { cache: 'no-store' })
        ]);
        if (!resp.ok) throw new Error('Falha ao buscar dados');
        const geojson = await resp.json();

        const db = new SQL.Database();
        db.run('PRAGMA application_id = 1196444487;'); // GPKG
        db.run('PRAGMA user_version = 10200;');         // v1.2.0

        db.run(`CREATE TABLE gpkg_spatial_ref_sys (
            srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY,
            organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
            definition TEXT NOT NULL, description TEXT)`);
        db.run(`INSERT INTO gpkg_spatial_ref_sys VALUES
            ('WGS 84 Geographic 2D', 4326, 'EPSG', 4326,
            'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]',
            'WGS 84')`);
        db.run(`INSERT INTO gpkg_spatial_ref_sys VALUES
            ('Undefined Cartesian', -1, 'NONE', -1, 'undefined', 'undefined cartesian')`);
        db.run(`INSERT INTO gpkg_spatial_ref_sys VALUES
            ('Undefined Geographic', 0, 'NONE', 0, 'undefined', 'undefined geographic')`);

        db.run(`CREATE TABLE gpkg_contents (
            table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL,
            identifier TEXT, description TEXT DEFAULT '',
            last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S.%fZ','now')),
            min_x REAL, min_y REAL, max_x REAL, max_y REAL,
            srs_id INTEGER REFERENCES gpkg_spatial_ref_sys(srs_id))`);

        db.run(`CREATE TABLE gpkg_geometry_columns (
            table_name TEXT NOT NULL REFERENCES gpkg_contents(table_name),
            column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL,
            srs_id INTEGER NOT NULL REFERENCES gpkg_spatial_ref_sys(srs_id),
            z TINYINT NOT NULL, m TINYINT NOT NULL,
            CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name))`);

        db.run(`CREATE TABLE gpkg_extensions (
            table_name TEXT, column_name TEXT, extension_name TEXT NOT NULL,
            definition TEXT NOT NULL, scope TEXT NOT NULL,
            CONSTRAINT ge_tce UNIQUE (table_name, column_name, extension_name))`);

        // Coletar todas as colunas de atributos
        const allCols = new Set();
        geojson.features.forEach(f => Object.keys(f.properties || {}).forEach(k => allCols.add(k)));
        const cols = Array.from(allCols);
        const tbl = layerName.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 60);
        const colDefs = cols.length ? ', ' + cols.map(c => `"${c.replace(/"/g,'""')}" TEXT`).join(', ') : '';

        db.run(`CREATE TABLE "${tbl}" (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom BLOB${colDefs})`);

        // Inserir feições
        const colList = cols.length ? ', ' + cols.map(c => `"${c.replace(/"/g,'""')}"`).join(', ') : '';
        const placeholders = cols.length ? ', ' + cols.map(() => '?').join(', ') : '';
        const stmt = db.prepare(`INSERT INTO "${tbl}" (geom${colList}) VALUES (?${placeholders})`);
        geojson.features.forEach(f => {
            const geomBlob = f.geometry ? wrapGpkgGeom(encodeWKB(f.geometry)) : null;
            const vals = [geomBlob, ...cols.map(c => {
                const v = (f.properties || {})[c];
                return v == null ? null : String(v);
            })];
            stmt.run(vals);
        });
        stmt.free();

        db.run(`INSERT INTO gpkg_contents (table_name, data_type, identifier, srs_id) VALUES (?, 'features', ?, 4326)`, [tbl, layerName]);
        db.run(`INSERT INTO gpkg_geometry_columns VALUES (?, 'geom', 'GEOMETRY', 4326, 0, 0)`, [tbl]);

        const data = db.export();
        db.close();

        const blob = new Blob([data], { type: 'application/geopackage+sqlite3' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${tbl}.gpkg`;
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (err) {
        alert(`Não foi possível gerar o GeoPackage de "${layerName}".`);
        console.error(err);
    }
}

// ============================================================
// Dropdown de seleção de formato de download
// ============================================================
const fmtDropdown = document.createElement('div');
fmtDropdown.id = 'fmt-dropdown';
fmtDropdown.innerHTML = `
    <button class="fmt-opt" data-fmt="geojson"><i class="fa-solid fa-file-code"></i> GeoJSON</button>
    <button class="fmt-opt" data-fmt="gpkg"><i class="fa-solid fa-database"></i> GeoPackage</button>
`;
document.body.appendChild(fmtDropdown);

let _fmtTarget = null;

fmtDropdown.querySelectorAll('.fmt-opt').forEach(btn => {
    btn.addEventListener('click', async () => {
        fmtDropdown.classList.remove('open');
        if (!_fmtTarget) return;
        const { folder, file, name, dlBtn } = _fmtTarget;
        dlBtn.classList.add('downloading');
        dlBtn.title = 'Baixando...';
        try {
            if (btn.dataset.fmt === 'geojson') {
                await downloadLayerAsGeoJSON(folder, file, name);
            } else {
                await downloadLayerAsGpkg(folder, file, name);
            }
        } finally {
            dlBtn.classList.remove('downloading');
            dlBtn.title = 'Baixar camada';
        }
    });
});

document.addEventListener('click', (e) => {
    if (!fmtDropdown.contains(e.target) && !e.target.closest('.btn-download-kml')) {
        fmtDropdown.classList.remove('open');
    }
});

function showFmtDropdown(dlBtn, target) {
    _fmtTarget = { ...target, dlBtn };
    const rect = dlBtn.getBoundingClientRect();
    fmtDropdown.style.top  = `${rect.bottom + 4}px`;
    fmtDropdown.style.left = `${rect.left}px`;
    fmtDropdown.classList.toggle('open');
}

// ============================================================
// Paleta de cores para as camadas
// ============================================================
// Define beautiful colors for layers
const palette = [
    '#facc15', '#38bdf8', '#fb7185', '#34d399', '#c084fc', 
    '#fb923c', '#a3e635', '#60a5fa', '#f472b6', '#818cf8', 
    '#10b981', '#f87171', '#2dd4bf', '#a78bfa', '#fcd34d'
];
let colorIndex = 0;

function getNextColor() {
    const color = palette[colorIndex % palette.length];
    colorIndex++;
    return color;
}

// Configuração das camadas
const layersConfig = {
    malhas: {
        folder: "Malhas Territoriais",
        containerId: "layer-list-malhas",
        list: [
            { name: "Mesorregiões", file: "Mesorregioes.geojson" },
            { name: "Microregiões", file: "Microrregioes.geojson" },
            { name: "Municípios", file: "Municipios.geojson" }
        ]
    },
    geo: {
        folder: "Geoambientais",
        containerId: "layer-list-geo",
        list: [
            { name: "Bacias Hidrográficas", file: "Bacias_Hidrograficas.geojson" },
            { name: "Biomas", file: "Biomas.geojson" },
            { name: "Regiões Fitogeográficas", file: "Regioes_Fitogeograficas.geojson" },
            { name: "Solos", file: "Solos.geojson" }
        ]
    },
    hidrografia: {
        folder: "Hidrografia",
        containerId: "layer-list-hidrografia",
        list: [
            { name: "CELMM", file: "CELMM.geojson" },
            { name: "Hidrografia", file: "Hidrografia.geojson" },
            { name: "Rio São Francisco", file: "Rio_Sao_Francisco.geojson" }
        ]
    },
    restricoes: {
        folder: "Restricoes",
        containerId: "layer-list-restricoes",
        list: [
            { name: "Aldeias", file: "Aldeias.geojson" },
            { name: "Área Acordo IMA MPF", file: "Area_Acordo_IMA_MPF.geojson" },
            { name: "Áreas Quilombolas", file: "Areas_Quilombolas.geojson" },
            { name: "Dunas do Cavalo Russo", file: "Dunas_do_Cavalo_Russo.geojson" },
            { name: "Ferrovias", file: "Ferrovias.geojson" },
            { name: "Gasoduto de Distribuição", file: "Gasoduto_de_Distribuicao.geojson" },
            { name: "Gasodutos de Transporte", file: "Gasodutos_de_Transporte.geojson" },
            { name: "Linha Preamar", file: "Linha_Preamar.geojson" },
            { name: "Linhas de Transmissão", file: "Linhas_de_Transmissao.geojson" },
            { name: "Manguezal", file: "Manguezal.geojson" },
            { name: "Sítios Arqueológicos", file: "Sitios_Arqueologicos.geojson" },
            { name: "Terreno de Marinha", file: "Terreno_de_Marinha.geojson" },
            { name: "Terras Indígenas", file: "Terras_Indigenas.geojson" },
            { name: "Unidades de Conservação", file: "Unidades_de_Conservacao.geojson" },
            { name: "ZA Esec Curral do Meio", file: "ZA_Esec_Curral_do_Meio.geojson" },
            { name: "ZA Esec de Murici", file: "ZA_Esec_de_Murici.geojson" },
            { name: "ZA MONA do São Francisco", file: "ZA_MONA_do_Sao_Francisco.geojson" },
            { name: "ZA RVS Craúna", file: "ZA_RVS_Crauna.geojson" },
            { name: "ZA Rebio PedraTalhada", file: "ZA_Rebio_PedraTalhada.geojson" }
        ]
    },
    monitoramento: {
        folder: "Monitoramento e Fiscalizacao",
        containerId: "layer-list-monitoramento",
        list: [
            { name: "Áreas Analisadas - Licenciamento", file: "Areas_Analisadas_Licenciamento.geojson" },
            { name: "Áreas Embargadas", file: "Areas_Embargadas.geojson" },
            { name: "ASV Analisadas (Polígonos)", file: "ASV_Analisadas_Poligonos.geojson" },
            { name: "ASV Analisadas (Pontos)", file: "ASV_Analisadas_Pontos.geojson" }
        ]
    }
};

// Map Initialization
const basemaps = {
    osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 19
    }),
    satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri',
        maxZoom: 19
    }),
    dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
        maxZoom: 19
    })
};

const map = L.map('map', {
    center: [-9.6498, -36.6601], // Alagoas center
    zoom: 8,
    layers: [basemaps.osm],
    zoomControl: false
});

// Criar painéis com z-index definidos para garantir a ordem correta de sobreposição
map.createPane('malhasPane');
map.getPane('malhasPane').style.zIndex = 400; // Fica mais ao fundo

map.createPane('geoPane');
map.getPane('geoPane').style.zIndex = 410; // Fica no meio

map.createPane('hidroPane');
map.getPane('hidroPane').style.zIndex = 415; // Hidrografia acima do meio

map.createPane('restricoesPane');
map.getPane('restricoesPane').style.zIndex = 420; // Fica na frente de tudo

map.createPane('customPane');
map.getPane('customPane').style.zIndex = 500; // Camadas customizadas e desenhos SEMPRE no topo

L.control.zoom({ position: 'bottomright' }).addTo(map);

// Controle de Escala
L.control.scale({
    metric: true,
    imperial: false,
    position: 'bottomleft'
}).addTo(map);

// Controle de Localização do Usuário (GPS)
L.control.locate({
    position: 'bottomright',
    strings: {
        title: "Mostrar minha localização"
    },
    locateOptions: {
        maxZoom: 16,
        enableHighAccuracy: true
    }
}).addTo(map);

// Change Basemap
let currentBasemap = 'osm';

function getMunicipiosStyle() {
    return {
        color: (currentBasemap === 'satellite' || currentBasemap === 'dark') ? '#ffffff' : '#000000',
        weight: 1.5,
        opacity: 0.8,
        fillColor: 'transparent',
        fillOpacity: 0
    };
}

document.querySelectorAll('input[name="basemap"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        Object.values(basemaps).forEach(layer => map.removeLayer(layer));
        basemaps[e.target.value].addTo(map);
        currentBasemap = e.target.value;
        
        // Atualizar o estilo dos Municípios se a camada estiver ativa
        const municipiosId = 'layer_Municipios_geojson';
        if (activeGeoJsonLayers[municipiosId]) {
            activeGeoJsonLayers[municipiosId].setStyle(getMunicipiosStyle());
        }
    });
});

// Loading state manager
const loadingIndicator = document.getElementById('loading-indicator');
let loadingCount = 0;

function setLoading(isLoading) {
    if (isLoading) {
        loadingCount++;
        loadingIndicator.classList.remove('hidden');
    } else {
        loadingCount = Math.max(0, loadingCount - 1);
        if (loadingCount === 0) {
            loadingIndicator.classList.add('hidden');
        }
    }
}

// Generate Layers UI and logic
const activeGeoJsonLayers = {}; // Store active leaflet layers
const activeLayersMeta = {}; // Store metadata for legends

function guessLabel(properties) {
    if (!properties) return "Feição";
    const possibleKeys = ['nome', 'name', 'classe', 'tipo', 'legenda', 'descricao', 'bioma', 'bacia', 'fitofisionomia'];
    for (let key of possibleKeys) {
        const foundKey = Object.keys(properties).find(k => k.toLowerCase() === key);
        if (foundKey && properties[foundKey]) {
            return properties[foundKey];
        }
    }
    const fallbackKey = Object.keys(properties).find(k => k.toLowerCase() !== 'cor' && typeof properties[k] === 'string' && properties[k].length < 50);
    return fallbackKey ? properties[fallbackKey] : "Feição";
}

// Configuração do controle de legenda global
const legendControl = L.control({ position: 'bottomleft' });

legendControl.onAdd = function (map) {
    this._div = L.DomUtil.create('div', 'info legend');
    this._div.style.background = 'var(--panel-bg)';
    this._div.style.padding = '10px 15px';
    this._div.style.color = 'var(--text-primary)';
    this._div.style.borderRadius = '8px';
    this._div.style.border = '1px solid var(--panel-border)';
    this._div.style.boxShadow = '0 0 15px rgba(0,0,0,0.2)';
    this._div.style.backdropFilter = 'blur(12px)';
    this._div.style.display = 'none';
    this._div.style.maxHeight = '300px';
    this._div.style.overflowY = 'auto';
    return this._div;
};

legendControl.update = function () {
    let html = '<h4 style="margin-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.2); padding-bottom:5px;">Legenda</h4>';
    let hasLegendData = false;
    
    Object.keys(activeLayersMeta).forEach(layerId => {
        const layerMeta = activeLayersMeta[layerId];
        if (layerMeta && layerMeta.legendItems && layerMeta.legendItems.length > 0) {
            hasLegendData = true;
            html += `<div style="margin-top: 10px; font-weight: bold; font-size: 0.9em; margin-bottom: 5px;">${layerMeta.name}</div>`;
            layerMeta.legendItems.forEach(item => {
                html += `
                    <div style="display: flex; align-items: center; margin-bottom: 4px; font-size: 0.85em;">
                        <i style="background: ${item.color}; width: 14px; height: 14px; display: inline-block; margin-right: 8px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.3);"></i>
                        ${item.label}
                    </div>
                `;
            });
        }
    });
    
    if (!hasLegendData) {
        this._div.style.display = 'none';
        this._div.innerHTML = '';
    } else {
        this._div.style.display = 'block';
        this._div.innerHTML = html;
    }
};

legendControl.addTo(map);

Object.keys(layersConfig).forEach(categoryKey => {
    const category = layersConfig[categoryKey];
    const container = document.getElementById(category.containerId);

    category.list.forEach(layer => {
        // Fixar cor para camadas de hidrografia
        const layerColor = categoryKey === 'hidrografia' ? '#5dddff' : getNextColor();
        const layerId = `layer_${layer.file.replace(/[^a-zA-Z0-9]/g, '_')}`;

        // Create UI element — label (checkbox) + download button wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'layer-item-wrapper';

        const label = document.createElement('label');
        label.className = 'layer-item';
        label.innerHTML = `
            <input type="checkbox" id="${layerId}">
            <span class="checkmark"></span>
            ${layer.name}
            <span class="layer-color-indicator" style="background-color: ${layerColor}40; border-color: ${layerColor}"></span>
        `;

        // Botão de download
        const dlBtn = document.createElement('button');
        dlBtn.className = 'btn-download-kml';
        dlBtn.title = 'Baixar camada';
        dlBtn.innerHTML = '<i class="fa-solid fa-download"></i>';
        dlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showFmtDropdown(dlBtn, {
                folder: category.folder,
                file: layer.file,
                name: layer.name,
                layerColor,
                isMunicipios: layer.file === 'Municipios.geojson'
            });
        });

        wrapper.appendChild(label);
        wrapper.appendChild(dlBtn);
        container.appendChild(wrapper);

        // Add Logic
        const checkbox = label.querySelector('input');
        checkbox.addEventListener('change', async (e) => {
            if (e.target.checked) {
                // Carregar GeoJSON
                const url = `${encodeURIComponent(category.folder)}/${encodeURIComponent(layer.file)}`;
                setLoading(true);
                
                try {
                    const response = await fetch(url, { cache: 'no-store' });
                    if (!response.ok) throw new Error("Erro ao buscar dados");
                    const data = await response.json();

                    // Mapeamento de cores da própria camada
                    const legendMap = new Map();
                    
                    data.features.forEach(feature => {
                        // Se a feature possuir a propriedade "cor", vamos catalogá-la para a legenda
                        const keys = Object.keys(feature.properties || {});
                        const corKey = keys.find(k => k.toLowerCase() === 'cor');
                        if (corKey && feature.properties[corKey]) {
                            const color = feature.properties[corKey];
                            const label = guessLabel(feature.properties);
                            if (!legendMap.has(color)) {
                                legendMap.set(color, label);
                            }
                        }
                    });
                    
                    const legendItems = [];
                    legendMap.forEach((label, color) => {
                        // Ignorar entradas genéricas sem classificação real
                        if (label && label !== 'Feição') {
                            legendItems.push({ color, label });
                        }
                    });
                    
                    activeLayersMeta[layerId] = {
                        name: layer.name,
                        legendItems: legendItems
                    };

                    // Ocultar o indicador de cor na sidebar quando a camada tem legenda própria
                    if (legendItems.length > 0) {
                        const indicator = label.querySelector('.layer-color-indicator');
                        if (indicator) indicator.style.display = 'none';
                    }

                    // Determinar qual painel usar com base na categoria
                    let paneName = 'restricoesPane';
                    if (categoryKey === 'malhas') paneName = 'malhasPane';
                    if (categoryKey === 'geo') paneName = 'geoPane';
                    if (categoryKey === 'hidrografia') paneName = 'hidroPane';

                    // Create Leaflet Layer with styles
                    const geoJsonLayer = L.geoJSON(data, {
                        pane: paneName,
                        style: function (feature) {
                            if (layer.file === "Municipios.geojson") {
                                return getMunicipiosStyle();
                            }
                            
                            let featureColor = layerColor;
                            const keys = Object.keys(feature.properties || {});
                            const corKey = keys.find(k => k.toLowerCase() === 'cor');
                            if (corKey && feature.properties[corKey]) {
                                featureColor = feature.properties[corKey];
                            }
                            
                            // Feições com cor própria ficam menos transparentes e com borda mais fina
                            const hasOwnColor = (featureColor !== layerColor);
                            return {
                                color: featureColor,
                                weight: hasOwnColor ? 0.4 : 1.5,
                                opacity: hasOwnColor ? 0.6 : 0.8,
                                fillColor: featureColor,
                                fillOpacity: hasOwnColor ? 0.65 : 0.3
                            };
                        },
                        pointToLayer: function (feature, latlng) {
                            let featureColor = layerColor;
                            const keys = Object.keys(feature.properties || {});
                            const corKey = keys.find(k => k.toLowerCase() === 'cor');
                            if (corKey && feature.properties[corKey]) {
                                featureColor = feature.properties[corKey];
                            }
                            
                            return L.circleMarker(latlng, {
                                radius: 6,
                                fillColor: featureColor,
                                color: "#fff",
                                weight: 1,
                                opacity: 1,
                                fillOpacity: 0.8
                            });
                        },
                        onEachFeature: function (feature, layer) {
                            // Simple popup
                            if (feature.properties) {
                                let popupContent = "<div style='max-height: 200px; overflow-y: auto;'>";
                                Object.keys(feature.properties).forEach(key => {
                                    popupContent += `<strong>${key}:</strong> ${feature.properties[key]}<br>`;
                                });
                                popupContent += "</div>";
                                layer.bindPopup(popupContent);
                            }
                        }
                    });

                    geoJsonLayer.addTo(map);
                    activeGeoJsonLayers[layerId] = geoJsonLayer;
                    legendControl.update();
                    
                    // Fit bounds to newly added layer
                    if (Object.keys(activeGeoJsonLayers).length === 1) {
                        map.fitBounds(geoJsonLayer.getBounds());
                    }

                } catch (error) {
                    console.error("Erro ao carregar a camada:", error);
                    alert(`Não foi possível carregar a camada ${layer.name}.`);
                    checkbox.checked = false;
                } finally {
                    setLoading(false);
                }
            } else {
                // Remover GeoJSON
                if (activeGeoJsonLayers[layerId]) {
                    map.removeLayer(activeGeoJsonLayers[layerId]);
                    delete activeGeoJsonLayers[layerId];
                    delete activeLayersMeta[layerId];
                    legendControl.update();
                }
            }
        });
    });
});

// ============================================================
// Ferramentas SIG: Leaflet-Geoman (Desenho)
// ============================================================

// Inicializar controles do Geoman
map.pm.addControls({
    position: 'topleft',
    drawCircle: false,
    drawCircleMarker: false,
    drawText: false,
    cutPolygon: false,
    editMode: true,
    dragMode: true,
    removalMode: true,
});

map.pm.setGlobalOptions({
    pathOptions: {
        pane: 'customPane'
    }
});

// Criar um FeatureGroup para armazenar as geometrias desenhadas
const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

// O Geoman adiciona as formas diretamente ao mapa por padrão,
// vamos capturar quando uma forma for criada e movê-la para nosso FeatureGroup.
map.on('pm:create', (e) => {
    drawnItems.addLayer(e.layer);
    updateExportButtonState();
    
    // Ouvir também quando essa layer for apagada
    e.layer.on('pm:remove', () => {
        drawnItems.removeLayer(e.layer);
        updateExportButtonState();
    });
});

map.on('pm:remove', (e) => {
    updateExportButtonState();
});

const btnExportDraw = document.getElementById('btn-export-draw');

function updateExportButtonState() {
    if (drawnItems.getLayers().length > 0) {
        btnExportDraw.disabled = false;
    } else {
        btnExportDraw.disabled = true;
    }
}

btnExportDraw.addEventListener('click', () => {
    if (drawnItems.getLayers().length === 0) return;
    
    try {
        // Converter grupo Leaflet para GeoJSON
        const geojson = drawnItems.toGeoJSON();
        
        // Converter GeoJSON para KML usando tokml
        const kml = tokml(geojson, {
            documentName: 'Meus Desenhos',
            documentDescription: 'Feições desenhadas no Geoportal'
        });
        
        // Fazer o download do arquivo KML
        const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'meus_desenhos.kml';
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (err) {
        console.error('Erro ao exportar desenho para KML:', err);
        alert('Ocorreu um erro ao exportar os desenhos.');
    }
});

// ============================================================
// Ferramentas SIG: Importar KML Próprio
// ============================================================
const kmlUploadInput = document.getElementById('kml-upload');

kmlUploadInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(evt) {
        try {
            const kmlText = evt.target.result;
            
            // Converter texto KML em Documento XML
            const parser = new DOMParser();
            const kmlDom = parser.parseFromString(kmlText, 'text/xml');
            
            // Converter KML DOM para GeoJSON usando togeojson
            const geojson = toGeoJSON.kml(kmlDom);
            
            if (geojson.features && geojson.features.length > 0) {
                // Adicionar GeoJSON ao mapa
                const customLayer = L.geoJSON(geojson, {
                    pane: 'customPane',
                    style: {
                        color: '#ff00ff', // Cor de destaque para uploads
                        weight: 2,
                        opacity: 0.8,
                        fillOpacity: 0
                    },
                    onEachFeature: function (feature, layer) {
                        if (feature.properties) {
                            let popupContent = "<h4>Feição KML</h4><div style='max-height: 200px; overflow-y: auto;'>";
                            Object.keys(feature.properties).forEach(key => {
                                if (key !== 'styleUrl' && key !== 'styleHash') {
                                    popupContent += `<strong>${key}:</strong> ${feature.properties[key]}<br>`;
                                }
                            });
                            popupContent += "</div>";
                            layer.bindPopup(popupContent);
                        }
                    }
                });
                
                customLayer.addTo(map);
                map.fitBounds(customLayer.getBounds());
                
                alert(`KML "${file.name}" importado com sucesso!`);
            } else {
                alert('Nenhuma feição geográfica encontrada no arquivo KML.');
            }
        } catch (err) {
            console.error('Erro ao importar KML:', err);
            alert('Não foi possível ler o arquivo KML fornecido. Ele pode estar malformado.');
        } finally {
            // Resetar o input para permitir carregar o mesmo arquivo novamente, se necessário
            kmlUploadInput.value = '';
        }
    };
    
    reader.readAsText(file);
});

// ============================================================
// Responsividade: Menu Toggle (Desktop e Mobile)
// ============================================================
const sidebarToggleBtn = document.getElementById('sidebar-toggle');
const sidebar = document.getElementById('sidebar');
const initialIcon = sidebarToggleBtn.querySelector('i');

// Em telas menores, iniciar a barra lateral fechada
if (window.innerWidth <= 1024) {
    sidebar.classList.add('sidebar-closed');
    initialIcon.classList.remove('fa-chevron-left');
    initialIcon.classList.add('fa-chevron-right');
} else {
    // No desktop inicia aberta
    initialIcon.classList.remove('fa-chevron-right');
    initialIcon.classList.add('fa-chevron-left');
}

sidebarToggleBtn.addEventListener('click', () => {
    sidebar.classList.toggle('sidebar-closed');
    
    // Trocar ícone
    const icon = sidebarToggleBtn.querySelector('i');
    if (sidebar.classList.contains('sidebar-closed')) {
        icon.classList.remove('fa-chevron-left');
        icon.classList.add('fa-chevron-right');
    } else {
        icon.classList.remove('fa-chevron-right');
        icon.classList.add('fa-chevron-left');
    }
    
    // Recalcular o tamanho do mapa após a transição
    setTimeout(() => { map.invalidateSize(); }, 300);
});

// Fechar menu ao clicar no mapa em telas pequenas
map.on('click', () => {
    if (window.innerWidth <= 1024 && !sidebar.classList.contains('sidebar-closed')) {
        sidebar.classList.add('sidebar-closed');
        const icon = sidebarToggleBtn.querySelector('i');
        icon.classList.remove('fa-chevron-left');
        icon.classList.add('fa-chevron-right');
    }
});
