import knexTourenDb from "../knexTourenDb";
import knex from "../knex";
import {createImagesFromMap} from "../utils/gpx/gpxUtils";
import moment from "moment";
import {hashString, minutesFromMoment} from "../utils/helper";
import {round} from "../utils/utils";
const { create, builder } = require('xmlbuilder2');
const fs = require('fs-extra');
const path = require('path');
import pLimit from 'p-limit';

export async function fixTours(){
    await knex.raw(`UPDATE tour SET search_column = to_tsvector( 'german', full_text );`);
    await knex.raw(`DELETE FROM city WHERE city_slug NOT IN (SELECT DISTINCT city_slug FROM fahrplan);`);
}


export async function writeKPIs(){
    await knex.raw(`DELETE FROM kpi WHERE kpi.name='total_tours';`);
    await knex.raw(`INSERT INTO kpi SELECT 'total_tours', COUNT(id) FROM tour;`);

    await knex.raw(`DELETE FROM kpi WHERE kpi.name='total_connections';`);
    await knex.raw(`INSERT INTO kpi SELECT 'total_connections', COUNT(id) FROM fahrplan;`);

    await knex.raw(`DELETE FROM kpi WHERE kpi.name='total_ranges';`);
    await knex.raw(`INSERT INTO kpi SELECT 'total_ranges', COUNT(DISTINCT range) FROM tour;`);

    await knex.raw(`DELETE FROM kpi WHERE kpi.name='total_cities';`);
    await knex.raw(`INSERT INTO kpi SELECT 'total_cities', COUNT(DISTINCT city_slug) FROM city;`);

    await knex.raw(`DELETE FROM kpi WHERE kpi.name='total_provider';`);
    await knex.raw(`INSERT INTO kpi SELECT 'total_provider', COUNT(DISTINCT provider) FROM tour;`);
}


export async function getProvider(){
    await knex.raw(`TRUNCATE provider;`);
    var query_result;
    try {
        query_result = await knexTourenDb('lookup_provider').select().where({active: 'y'});
    }
    catch(err){
        console.log('error: ', err)
        return false;
    }
    if(!!query_result && query_result.length > 0){
        for(let i=0; i<query_result.length; i++){
            const entry = query_result[i];

            try {
                const query = knex('provider').insert({
                    provider: entry.provider,
                    provider_name: entry.provider_name,
                });
                /*
                if(process.env.NODE_ENV != "production"){
                    console.log('query: ', query.toQuery());
                }
                */
                await query;
            } catch(err){
                console.log('error: ', err)
                return false;
            }
        }
    }
}


async function _syncConnectionGPX(key, fileName, title){
    return new Promise(async resolve => {
        let filePath = '';
        if(process.env.NODE_ENV == "production"){
            filePath = path.join(__dirname, "../", fileName);
        } else {
            filePath = path.join(__dirname, "../../", fileName);
        }

        if(!!key){
            deleteFileModulo30(fileName, filePath);

            if (!!!fs.existsSync(filePath)) {
                const trackPoints = await knexTourenDb('interface_tracks_to_search').select().where({track_key: key}).orderBy('track_point_sequence', 'asc');
                if(!!trackPoints && trackPoints.length > 0){
                    await createFileFromGpx(trackPoints, filePath, title, 'track_point_lat', 'track_point_lon', 'track_point_elevation');
                }
            }
        }

        resolve();
    })
}

export async function syncConnectionGPX(){
    const _limit = pLimit(25);

    const toTourFahrplan = await knex('fahrplan').select(['totour_track_key']).whereNotNull('totour_track_key').groupBy('totour_track_key');
    if(!!toTourFahrplan){
        const promises = toTourFahrplan.map(entry => {
            return _limit(() => _syncConnectionGPX(entry.totour_track_key, 'public/gpx-track/totour_track_' + entry.totour_track_key + '.gpx', 'Station zur Tour'))
        });
        await Promise.all(promises);
    }

    const fromTourFahrplan = await knex('fahrplan').select(['fromtour_track_key']).whereNotNull('fromtour_track_key').groupBy('fromtour_track_key');
    if(!!fromTourFahrplan) {
        const promises = fromTourFahrplan.map(entry => {
            return _limit(() =>  _syncConnectionGPX(entry.fromtour_track_key, 'public/gpx-track/fromtour_track_' + entry.fromtour_track_key + '.gpx', 'Tour zur Station'))
        });
        await Promise.all(promises);
    }

    return true;
}

export async function syncGPX(){
    const allTours = await knex('tour').select(["title", "hashed_url", "provider"]).distinct();
    if(!!allTours && allTours.length > 0){
        const _limit = pLimit(25);
        const promises = allTours.map(entry => {
            return _limit(() => _syncGPX(entry.provider, entry.hashed_url, entry.title));
        });
        await Promise.all(promises);
    }
    return true;

}

export async function syncGPXImage(){
    let allHashedUrls = await knex.raw("SELECT CONCAT(provider,'_',hashed_url) as hashed_url FROM tour;");
    if(!!allHashedUrls && allHashedUrls.rows){
        allHashedUrls = allHashedUrls.rows;
        let toCreate = [];
        for(let i=0;i<allHashedUrls.length;i++){
            let entry = allHashedUrls[i];
            toCreate.push({
                hashed_url: entry.hashed_url,
            })
        }
        if(!!toCreate){
            await createImagesFromMap(toCreate.map(e => e.hashed_url));
        }
    }
    return true;

}


async function _syncGPX(prov, h_url, title){
    return new Promise(async resolve => {
        try {
            let fileName = 'public/gpx/' + prov + '_' + h_url + '.gpx';
            let filePath = '';
            if(process.env.NODE_ENV == "production"){
                filePath = path.join(__dirname, "../", fileName);
            } else {
                filePath = path.join(__dirname, "../../", fileName);
            }
            deleteFileModulo30(h_url, filePath);

            if (!!!fs.existsSync(filePath)) {
                const waypoints = await knexTourenDb('Interface_GPX_to_search').select().where({hashed_url: h_url, provider: prov}).orderBy('waypoint');
                if(!!waypoints && waypoints.length > 0 && !!filePath){
                    await createFileFromGpx(waypoints, filePath, title);
                }
            } 
        } catch(err) {
            console.error(err)
        }

        resolve();
    })
}

async function createFileFromGpx(data, filePath, title, fieldLat = "lat", fieldLng = "lon", fieldEle = "ele"){
    if(!!data){
        if(process.env.NODE_ENV != "production"){
            // console.log(`create file [${filePath}]`);
        }
        
        const root = create({ version: '1.0' })
            .ele('gpx', { version: "1.1", xmlns: "http://www.topografix.com/GPX/1/1", "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance" })
            .ele('trk')
            .ele('name').txt(title).up()
            .ele('trkseg');

        data.forEach(wp => {
            root.ele('trkpt', {lat: wp[fieldLat], lon: wp[fieldLng]})
                .ele('ele').txt(wp[fieldEle]);
        });

        const xml = root.end({ prettyPrint: true });
        if(!!xml){
            await fs.writeFileSync(filePath, xml);
        }
    }
}

export async function syncFahrplan(mode='delta'){

    if(mode=='delta'){
        // delta mode
        await syncFahrplan_del();

        try {
            await knex.raw(`DELETE FROM fahrplan WHERE calendar_date < CURRENT_DATE;`);
            await knex.raw(`DELETE FROM fahrplan WHERE id IN (SELECT id FROM fahrplan_del);`);
        } catch(err){
            console.log('error: ', err)
        }
        // console.log('del Inserts done');
    }
    else {
        // In full load mode, we want everything gone and inserted new
        try {
            await knex.raw(`TRUNCATE fahrplan;`);
        } catch(err){
            console.log('error: ', err)
        }
        // console.log('Truncate done');
    }

    // Now add new lines
    let limit = 10000;
    let counter = 0;
    let where = {delta_type: 'add'};
    let orwhere = {delta_type: 'noc'};
    const _limit = pLimit(2);
    let bundles = [];
    let trigger_id_min = 0;
    let trigger_id_max = 0;
    let trigger_id_min_array = [];
    let trigger_id_max_array = [];
    let chunksizer = 0;

    if(mode=='delta'){
        orwhere = {delta_type: 'xxx'};
    }

    try {
        const query_add_min = knexTourenDb('interface_fplan_to_search_delta').min('trigger_id').whereRaw(`calendar_date >= CURRENT_DATE`).andWhere( (whereBuilder) => whereBuilder.where(where).orWhere(orwhere) );
        const query_add_max = knexTourenDb('interface_fplan_to_search_delta').max('trigger_id').whereRaw(`calendar_date >= CURRENT_DATE`).andWhere( (whereBuilder) => whereBuilder.where(where).orWhere(orwhere) );
        // console.log('syncFahrplan query add min: ', query_add_min.toQuery());
        // console.log('syncFahrplan query add max: ', query_add_max.toQuery());
        trigger_id_min_array = await query_add_min;
        trigger_id_max_array = await query_add_max;
        trigger_id_min = trigger_id_min_array[0]['min(`trigger_id`)']
        trigger_id_max = trigger_id_max_array[0]['max(`trigger_id`)'];
    } catch(err){
        console.log('error: ', err);
    }

    const query_count = await knexTourenDb('interface_fplan_to_search_delta').count('* as anzahl').whereRaw(`calendar_date >= CURRENT_DATE`).andWhere( (whereBuilder) => whereBuilder.where(where).orWhere(orwhere) ); 
    chunksizer = round( query_count[0]["anzahl"] / limit, 0 );
    if (isNaN(chunksizer) || chunksizer < 1) { 
        chunksizer = 1;
    }

    console.log('(Info: Handling ', query_count[0]["anzahl"], ' rows fplan data.');
    while (counter < chunksizer) {
        bundles.push({
            leftover: counter,
            chunksizer: chunksizer
        });
        counter++;
    }

    // console.log('Starting add Inserts');

    // remove all indizes from PostgreSQL table "fahrplan" for quicker inserts
    try {
        await knex.raw(`DROP INDEX IF EXISTS public.fahrplan_best_connection_duration_idx;`);
        await knex.raw(`DROP INDEX IF EXISTS public.fahrplan_city_slug_idx;`);
        await knex.raw(`DROP INDEX IF EXISTS public.fahrplan_connection_duration_idx;`);
        await knex.raw(`DROP INDEX IF EXISTS public.fahrplan_fromtour_track_duration_idx;`);
        await knex.raw(`DROP INDEX IF EXISTS public.fahrplan_fromtour_track_key_idx;`);
        await knex.raw(`DROP INDEX IF EXISTS public.fahrplan_hashed_url_idx;`);
        await knex.raw(`DROP INDEX IF EXISTS public.fahrplan_hashed_url_tour_provider_idx;`);
        await knex.raw(`DROP INDEX IF EXISTS public.fahrplan_internal_status_idx;`);
        await knex.raw(`DROP INDEX IF EXISTS public.fahrplan_totour_track_duration_idx;`);
        await knex.raw(`DROP INDEX IF EXISTS public.fahrplan_totour_track_key_idx;`);
        await knex.raw(`DROP INDEX IF EXISTS public.fahrplan_tour_provider_hashed_url_city_slug_idx;`);
        await knex.raw(`DROP INDEX IF EXISTS public.fahrplan_tour_provider_idx;`);
        await knex.raw(`DROP INDEX IF EXISTS public.fahrplan_weekday_type_idx;`);
    } catch(err){
        console.log('error: ', err);
    }

    const promises_add = bundles.map(bundle => {
        return _limit(() => readAndInsertFahrplan(bundle, where, orwhere));
    });
    await Promise.all(promises_add);


    // set all indizes on PostgreSQL table "fahrplan" again
    try{
        await knex.raw(`CREATE INDEX ON fahrplan (hashed_url, tour_provider);`);
        await knex.raw(`CREATE INDEX ON fahrplan (tour_provider);`);
        await knex.raw(`CREATE INDEX ON fahrplan (hashed_url);`);
        await knex.raw(`CREATE INDEX ON fahrplan (tour_provider, hashed_url, city_slug);`);
        await knex.raw(`CREATE INDEX ON fahrplan (totour_track_key);`);
        await knex.raw(`CREATE INDEX ON fahrplan (fromtour_track_key);`);
        await knex.raw(`CREATE INDEX ON fahrplan (connection_duration);`);
        await knex.raw(`CREATE INDEX ON fahrplan (best_connection_duration);`);
        await knex.raw(`CREATE INDEX ON fahrplan (totour_track_duration);`);
        await knex.raw(`CREATE INDEX ON fahrplan (fromtour_track_duration);`);
        await knex.raw(`CREATE INDEX ON fahrplan (city_slug);`);
        await knex.raw(`CREATE INDEX ON fahrplan (weekday_type);`);
    } catch(err){
        console.log('error: ', err);
    }
}


const syncFahrplan_del = async () => {
    let limit = 5000;
    let counter = 0;
    let where = {delta_type: 'del'};
    const _limit = pLimit(15);
    let bundles = [];
    let trigger_id_min = 0;
    let trigger_id_max = 0;
    let trigger_id_min_array = [];
    let trigger_id_max_array = [];

    try {
        await knex.raw(`TRUNCATE fahrplan_del;`);
    } catch(err){
        console.log('error: ', err)
    }

    try {
        const query_del_min = knexTourenDb('interface_fplan_to_search_delta').min('trigger_id').where(where);
        const query_del_max = knexTourenDb('interface_fplan_to_search_delta').max('trigger_id').where(where);
        // console.log('syncFahrplan query del min: ', query_del_min.toQuery());
        // console.log('syncFahrplan query del max: ', query_del_max.toQuery());
        trigger_id_min_array = await query_del_min;
        trigger_id_max_array = await query_del_max;
        trigger_id_min = trigger_id_min_array[0]['min(`trigger_id`)'];
        trigger_id_max = trigger_id_max_array[0]['max(`trigger_id`)'];
    } catch(err){
        console.log('error: ', err)
    }

    counter = trigger_id_min;
    bundles = [];
    while(counter <= (trigger_id_max + limit)){
        bundles.push({
            from: counter,
            to: counter + limit
        });
        counter = counter + limit;
    }
      
    const promises_del = bundles.map(bundle => {
        return _limit(() => readAndInsertFahrplan_del(bundle, where));
    });
    await Promise.all(promises_del);
}

const readAndInsertFahrplan = (bundle, where = {}, orwhere = {}) => {
    return new Promise(async resolve => {
        const result_query = knexTourenDb('interface_fplan_to_search_delta').select().whereRaw(`trigger_id % ${bundle.chunksizer} = ${bundle.leftover} AND calendar_date >= CURRENT_DATE`).andWhere( (whereBuilder) => whereBuilder.where(where).orWhere(orwhere) );
        // console.log('select interface_fplan_to_search_delta: ', result_query.toQuery());
        
        const result = await result_query;

        if(!!result && result.length > 0){
            await insertFahrplanMultiple(result);
        }
        resolve();
    })
}


const readAndInsertFahrplan_del = (bundle, where = {}) => {
    return new Promise(async resolve => {
        const result = await knexTourenDb('interface_fplan_to_search_delta').select('trigger_id').where(where).andWhere('trigger_id', '>=', bundle.from).andWhere('trigger_id', '<', bundle.to);
        if(!!result && result.length > 0){
            await insertFahrplanMultiple_del(result);
        }
        resolve();
    })
}


const insertFahrplanMultiple = async (entries) => {

    let attrToRemove = [
        "trigger_datetime",
        "tour_duration",
        "tour_hiking_days",
        "tour_title",
        "delta_type",
    ];

    let _entries = entries.map(entry => {
        attrToRemove.forEach(attr => {
            delete entry[attr];
        });

        if(!!entry.tour_id){
            entry.hashed_url = ""+entry.tour_id;
            delete entry.tour_id;
        }

        if(!!entry.trigger_id){
            entry.id = ""+entry.trigger_id;
            delete entry.trigger_id;
        }

        return entry;
    });

    try {
        await knex.raw(knex('fahrplan').insert([..._entries]).toString()+" ON CONFLICT(id) DO NOTHING");
        return true;
    } catch(err){
        console.log('error: ', err)
        return false;
    }
}

/** nur temporär für update -> kann nach dem 14.9. gelöscht werden */
export async function mergeToursWithGPX(){
    const tours = await knex('tour').select(['hashed_url', 'provider']);
    if(!!tours) {
        for (let i = 0; i < tours.length; i++) {
            let entry = tours[i];
            let gpxData = await knexTourenDb('Interface_GPX_to_search').select(["provider", "hashed_url", "lat", "lon", "ele", "typ"]).where({provider: entry.provider, hashed_url: entry.hashed_url}).whereIn("typ", ["first", "last"]);
            gpxData = gpxData.map(entry => {return {
                lat: entry.lat,
                lon: entry.lon,
                ele: entry.ele,
                typ: entry.typ,
            }});
            await knex('tour').update({
                gpx_data: JSON.stringify(gpxData),
            }).where({
                hashed_url: entry.hashed_url,
                provider: entry.provider
            });
        }
    }
}


const insertFahrplanMultiple_del = async (entries) => {

    let _entries = entries.map(entry => {
        if(!!entry.trigger_id){
            entry.id = ""+entry.trigger_id;
            delete entry.trigger_id;
        }
        return entry;
    });

    try {
        await knex('fahrplan_del').insert([..._entries]);
        return true;
    } catch(err){
        console.log('error: ', err)
        return false;
    }
}


export async function syncTours(){
    // Set Maintenance mode for Zuugle (webpage is disabled)
    await knex.raw('UPDATE kpi SET VALUE=0 WHERE name=\'total_tours\';');

    // Table tours will be rebuild from scratch
    await knex.raw(`TRUNCATE tour;`);

    let limit = 500;
    let offset = 0;
    let counter = 0;
    const countResult = await knexTourenDb('interface_touren_to_search').count('* as anzahl');

    let count = 0;
    if(!!countResult && countResult.length == 1 && countResult[0]["anzahl"]){
        count = countResult[0]["anzahl"];
    }

    while((counter *  limit) <= count){
        const query = knexTourenDb.raw(`select s.*, g1.lat as lat_start, g1.lon as lon_start, g2.lat as lat_end, g2.lon as lon_end from interface_touren_to_search s
                                                LEFT JOIN Interface_GPX_to_search g1 ON s.provider = g1.provider AND s.hashed_url = g1.hashed_url AND g1.typ = "first"
                                                LEFT JOIN Interface_GPX_to_search g2 ON s.provider = g2.provider AND s.hashed_url = g2.hashed_url AND g2.typ = "last"
                                                limit ${limit} offset ${offset};`);

        /*
        if(process.env.NODE_ENV != "production"){
            console.log('query: ', query.toQuery());
        }
        */
        const result = await query;
        if(!!result && result.length > 0 && result[0].length > 0){
            bulk_insert_tours(result[0]);
        }
        offset = offset + limit;
        counter++;
    }
}

export async function mergeToursWithFahrplan(){
    const cities = await knex('city').select();
    const tours = await knex('tour').select(['hashed_url', 'provider', 'duration']);
    
    if(!!tours){

        for(let i=0;i<tours.length;i++){

            let entry = tours[i];
            let fahrplan = await knex('fahrplan').select(['city_slug']).where({hashed_url: entry.hashed_url, tour_provider: entry.provider}).groupBy('city_slug');
            if(!!fahrplan && fahrplan.length > 0){
                await Promise.all(fahrplan.map(fp => new Promise(async resolve => {

                    let durations = {};
                    let connections = await knex('fahrplan').min(['connection_duration']).select(["weekday_type"]).where({hashed_url: entry.hashed_url, tour_provider: entry.provider, city_slug: fp.city_slug}).andWhereNot("connection_duration", null).groupBy('weekday_type');
                    if(!!connections && connections.length > 0){
                        connections.forEach(con => {
                            durations[con.weekday_type] = minutesFromMoment(moment(con.min, "HH:mm:ss"))
                        })
                    }

                    const values = await knex('fahrplan')
                        .avg('fromtour_track_duration as avg_fromtour_track_duration')
                        .avg('totour_track_duration as avg_totour_track_duration')
                        .min('best_connection_duration as min_best_connection_duration')
                        .where({hashed_url: entry.hashed_url, tour_provider: entry.provider, city_slug: fp.city_slug})
                        .andWhereNot("connection_duration", null)
                        .andWhereNot('fromtour_track_duration', null)
                        .andWhereNot('totour_track_duration', null)
                        .andWhereNot('best_connection_duration', null)
                        .first();

                    //let fromTourTrackDuration = await knex('fahrplan').avg('fromtour_track_duration').where({hashed_url: entry.hashed_url, tour_provider: entry.provider, city_slug: fp.city_slug}).andWhereNot("connection_duration", null).andWhereNot('fromtour_track_duration', null).first();
                    //let bestConnectionDuration = await knex('fahrplan').min(['best_connection_duration']).where({hashed_url: entry.hashed_url, tour_provider: entry.provider, city_slug: fp.city_slug}).andWhereNot("best_connection_duration", null).first();

                    fp.best_connection_duration = !!values ? minutesFromMoment(moment(values.min_best_connection_duration, "HH:mm:ss")) : undefined;
                    fp.durations = durations;

                    fp.total_tour_duration = round((
                        Number(entry.duration)
                        + getDurationValue(values.avg_totour_track_duration)
                        + getDurationValue(values.avg_fromtour_track_duration)), 2);
                    resolve(fp);
                })));

                let countryObject = {
                    country_at: false,
                    country_de: false,
                    country_ch: false,
                    country_it: false
                };
                let fahrplanObject = {}
                fahrplan.forEach(fp => {
                    fahrplanObject[fp.city_slug] = {
                        durations: {...fp.durations},
                        best_connection_duration: fp.best_connection_duration,
                        total_tour_duration: Math.ceil(fp.total_tour_duration / 0.25) * 0.25
                    };

                    const cityEntryFound = cities.find(c => c.city_slug === fp.city_slug);
                    if(!!cityEntryFound){
                        if(cityEntryFound.city_country === "AT" && countryObject['country_at'] === false){
                            countryObject['country_at'] = true;
                        } else if(cityEntryFound.city_country === "DE" && countryObject['country_de'] === false){
                            countryObject['country_de'] = true;
                        } else if(cityEntryFound.city_country === "CH" && countryObject['country_ch'] === false){
                            countryObject['country_ch'] = true;
                        } else if(cityEntryFound.city_country === "IT" && countryObject['country_it'] === false){
                            countryObject['country_it'] = true;
                        }
                    }
                })

                await knex('tour').update({
                    cities: JSON.stringify(fahrplan),
                    cities_object: JSON.stringify(fahrplanObject),
                    ...countryObject
                })
                .where({hashed_url: entry.hashed_url, provider: entry.provider});

            }
        }
    }
}

const getDurationValue = (value) => {
    let _valueMinutes = parsePostgresIntervalToMoment(value) / 60;
    if(_valueMinutes < 5){
        return 0;
    }
    return round(_valueMinutes / 60, 2);
}

const parsePostgresIntervalToMoment = (value) => {
    let result = 0; //seconds
    if(!!value && !!value.hours){
        result += value.hours * 60 * 60;
    }
    if(!!value && !!value.minutes){
        result += value.minutes * 60;
    }
    if(!!value && !!value.seconds){
        result += value.seconds;
    }
    return result;
}

const roundTo10 = (value) => {
    return Math.ceil(value / 10) * 10;
}

export async function syncCities(){
    const query = knexTourenDb('interface_cities_to_search').select();
    const result = await query;
    if(!!result && result.length > 0){
        for(let i=0; i<result.length; i++){
            await knex.raw(`insert into city values ('${result[i].city_slug}', '${result[i].city_name}', '${result[i].city_country}') ON CONFLICT (city_slug) DO NOTHING`);
        }
    }
    
}

const calcMonthOrder = (entry) => {
    const knowledge = getDynamicMonthNumber();
    let smallestValue = 12;
    knowledge.forEach(kn => {
        if(!!entry[kn.key] && kn.number < smallestValue){
            smallestValue = kn.number;
        }
    })

    return smallestValue;
}

export const getDynamicMonthNumber = () => {
    const knowledge = [];
    const start = moment();
    for(let i=1;i<=12;i++){
        knowledge.push({
            number: i,
            key: start.format('MMM').toLowerCase()
        })
        start.add(1, 'month');
    }
    return knowledge;
}

const bulk_insert_tours = async (entries) => {
    let queries = [];

    for (let i=0; i<entries.length; i++) {
        let entry = entries[i];
        if(entry.publishing_date == '0000-00-00'){
            delete entry['publishing_date'];
        }

        let gpxData = [];
        if(entry.lat_start && entry.lon_start){
            gpxData.push({
                lat: entry.lat_start,
                lon: entry.lon_start,
                typ: "first"
            });
        }
        if(entry.lat_end && entry.lon_end){
            gpxData.push({
                lat: entry.lat_end,
                lon: entry.lon_end,
                typ: "last"
            });
        }
        entry.gpx_data = JSON.stringify(gpxData);
        queries.push({
            url: entry.url,
            provider: entry.provider,
            hashed_url: entry.hashed_url,
            description: entry.description,
            image_url: entry.image_url,
            ascent: entry.ascent,
            descent: entry.descent,
            difficulty: entry.difficulty,
            duration: entry.duration,
            distance: entry.distance,
            title: entry.title,
            type: entry.typ,
            country: entry.country,
            state: entry.state,
            range_slug: entry.range_slug,
            range: entry.range_name,
            season: entry.season,
            children: entry.children,
            number_of_days: entry.number_of_days,
            jan: entry.jan,
            feb: entry.feb,
            mar: entry.mar,
            apr: entry.apr,
            may: entry.may,
            jun: entry.jun,
            jul: entry.jul,
            aug: entry.aug,
            sep: entry.sep,
            oct: entry.oct,
            nov: entry.nov,
            dec: entry.dec,
            month_order: calcMonthOrder(entry),
            traverse: entry.traverse,
            publishing_date: entry.publishing_date,
            quality_rating: entry.quality_rating,
            user_rating_avg: entry.user_rating_avg,
            full_text: entry.full_text,
            gpx_data: entry.gpx_data,
            difficulty_orig: entry.difficulty_orig
        });
    }

    try {
        await knex('tour').insert(queries);
        return true;
    } catch(err){
        console.log('error: ', err)
        return false;
    }
}

const insertCity = async (entry) => {
    try {
        await knex('city').insert({
            ...entry
        });
        return true;
    } catch(err){
        console.log('error: ', err)
        return false;
    }
}

const insertFahrplan = async (entry) => {

    let attrToRemove = [
        "trigger_id",
        "trigger_datetime",
        "tour_duration",
        "tour_hiking_days",
        "tour_title",
    ];

    attrToRemove.forEach(attr => {
        delete entry[attr];
    });

    if(!!entry.tour_id){
        entry.hashed_url = ""+entry.tour_id;
        delete entry.tour_id;
    }

    try {
        await knex('fahrplan').insert({
            ...entry
        });
        return true;
    } catch(err){
        console.log('error: ', err)
        return false;
    }
}

const compare = async () => {
    return true;
}

const deleteFileModulo30 = (h_url, filePath) => {
    if (!!fs.existsSync(filePath)) {
        const today = moment().format('D');
        const hash_day = hashString(h_url) % 30 + 1;
        if (today == hash_day) {
            try {
                fs.unlinkSync(filePath);
                if(process.env.NODE_ENV != "production"){
                    console.log('File deleted successfully: ', filePath);
                }
            } catch(err) {
                console.log(err.message);
            }
        }
    }
}