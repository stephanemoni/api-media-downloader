import { Agent, request } from "undici";
import ffmpeg from "ffmpeg-static";
import { spawn } from "child_process";
import { create as contentDisposition } from "content-disposition-header";

import { env } from "../config.js";
import { destroyInternalStream } from "./manage.js";
import { hlsExceptions } from "../processing/service-config.js";
import { getHeaders, closeRequest, closeResponse, pipe } from "./shared.js";

const ffmpegArgs = {
    webm: ["-c:v", "copy", "-c:a", "copy"],
    mp4: ["-c:v", "copy", "-c:a", "copy", "-movflags", "faststart+frag_keyframe+empty_moov"],
    m4a: ["-movflags", "frag_keyframe+empty_moov"],
    gif: ["-vf", "scale=-1:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", "-loop", "0"]
}

const metadataTags = [
    "album",
    "copyright",
    "title",
    "artist",
    "track",
    "date",
];

const convertMetadataToFFmpeg = (metadata) => {
    let args = [];

    for (const [ name, value ] of Object.entries(metadata)) {
        if (metadataTags.includes(name)) {
            args.push('-metadata', `${name}=${value.replace(/[\u0000-\u0009]/g, "")}`);
        } else {
            throw `${name} metadata tag is not supported.`;
        }
    }

    return args;
}

const toRawHeaders = (headers) => {
    return Object.entries(headers)
                 .map(([key, value]) => `${key}: ${value}\r\n`)
                 .join('');
}

const killProcess = (p) => {
    p?.kill('SIGTERM'); // ask the process to terminate itself gracefully

    setTimeout(() => {
        if (p?.exitCode === null)
            p?.kill('SIGKILL'); // brutally murder the process if it didn't quit
    }, 5000);
}

const getCommand = (args) => {
    if (typeof env.processingPriority === 'number' && !isNaN(env.processingPriority)) {
        return ['nice', ['-n', env.processingPriority.toString(), ffmpeg, ...args]]
    }
    return [ffmpeg, args]
}

const defaultAgent = new Agent();

const proxy = async (streamInfo, res) => {
    const abortController = new AbortController();
    const shutdown = () => (
        closeRequest(abortController),
        closeResponse(res),
        destroyInternalStream(streamInfo.urls)
    );

    try {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Content-disposition', contentDisposition(streamInfo.filename));

        const { body: stream, headers, statusCode } = await request(streamInfo.urls, {
            headers: {
                ...getHeaders(streamInfo.service),
                Range: streamInfo.range
            },
            signal: abortController.signal,
            maxRedirections: 16,
            dispatcher: defaultAgent,
        });

        res.status(statusCode);

        for (const headerName of ['accept-ranges', 'content-type', 'content-length']) {
            if (headers[headerName]) {
                res.setHeader(headerName, headers[headerName]);
            }
        }

        pipe(stream, res, shutdown);
    } catch {
        shutdown();
    }
}

const merge = (streamInfo, res) => {
    let process;
    const shutdown = () => (
        killProcess(process),
        closeResponse(res),
        streamInfo.urls.map(destroyInternalStream)
    );

    const headers = getHeaders(streamInfo.service);
    const rawHeaders = toRawHeaders(headers);

    try {
        if (streamInfo.urls.length !== 2) return shutdown();

        const format = streamInfo.filename.split('.')[streamInfo.filename.split('.').length - 1];

        let args = [
            '-loglevel', '-8',
            // '-loglevel', 'verbose',
            '-headers', rawHeaders,
            '-i', streamInfo.urls[0],
            '-headers', rawHeaders,
            '-i', streamInfo.urls[1],
            //'-map', '0:v',
            //'-map', '1:a',
        ]

        // args = args.concat(ffmpegArgs[format]);

        if (streamInfo.watermark) {
            let watermarkPosition;
            let watermarkScale;
            let watermarkOpacity;
            if (!/^(\d{1,4}:\d{1,4})$/.test(streamInfo.watermark.position)) {
                // console.log(streamInfo.watermark.position + " does not match d{1,4}:d{1,4}");
                switch (streamInfo.watermark.position) {
                    default:
                    case "center":
                        watermarkPosition = "(main_w-overlay_w)/2:(main_h-overlay_h)/2";
                        break;

                    case "topLeft":
                        watermarkPosition = "10:10";
                        break;
    
                    case "topRight":
                        watermarkPosition = "(main_w-overlay_w)-10:10";
                        break;
                                
                    case "bottomLeft":
                        watermarkPosition = "10:(main_h-overlay_h)-10";
                        break;
                    case "bottomRight":
                        watermarkPosition = "(main_w-overlay_w)-10:(main_h-overlay_h)-10";
                        break;
                }
            }
            else {
                // console.log(streamInfo.watermark.position + " matches d{1,4}:d{1,4}");
                watermarkPosition = streamInfo.watermark.position;
            }
            
            watermarkScale = (streamInfo.watermark.scale) ? streamInfo.watermark.scale : 1.0;
            watermarkOpacity = (streamInfo.watermark.opacity) ? streamInfo.watermark.opacity : 1.0;

            // console.log('watermark',streamInfo.watermark);
            // console.log('watermarkScale',watermarkScale);
            // console.log('watermarkPosition',watermarkPosition);
            // console.log('watermarkOpacity',watermarkOpacity);

            args.push('-i', streamInfo.watermark.url)
            
            //args.push('-filter_complex', `[0][2]overlay=${watermarkPosition}:format=yuv444[v]`)
            // args.push('-filter_complex', `[2]scale=iw*${watermarkScale}:-1[logo];[0][logo]overlay=${watermarkPosition}:format=yuv444[v]`)
            // args.push('-filter_complex', `[2][0]scale2ref=w=iw*${watermarkScale}:h=ow/mdar[logo][video];[video][logo]overlay=${watermarkPosition}:format=yuv444[v]`)
            // args.push('-filter_complex', `[2][0]scale2ref=w=iw*${watermarkScale}:h=ow/mdar[watermark][video];[watermark]colorchannelmixer=aa=${watermarkOpacity}[logo];[video][logo]overlay=${watermarkPosition}:format=yuv444[v]`)
            // args.push('-filter_complex', `[2][0]scale2ref=w=oh/mdar:h=ih*${watermarkScale}[watermark][video];[watermark]colorchannelmixer=aa=${watermarkOpacity}[logo];[video][logo]overlay=${watermarkPosition}:format=yuv444[v]`)
            args.push('-filter_complex', `[2][0]scale2ref=w='if(gte(iw\,ih)\,iw*${watermarkScale}\,oh/mdar)':h='if(gte(iw\,ih)\,ow/mdar\,ih*${watermarkScale})'[watermark][video];[watermark]colorchannelmixer=aa=${watermarkOpacity}[logo];[video][logo]overlay=${watermarkPosition}:format=yuv444[v]`)
            args.push('-map', '[v]')
            args.push('-map', '1:a')
            args.push('-movflags', 'frag_keyframe+empty_moov')
            args.push('-f', 'ismv')
            
            const ffmpegNewArgs = ffmpegArgs[format].splice(2,ffmpegArgs[format].length-2);
            args = args.concat(ffmpegNewArgs);
            
        }
        else {
            args.push('-map', '0:v')
            args.push('-map', '1:a')
            args.push('-movflags', 'frag_keyframe+empty_moov')
            args.push('-f', 'ismv')
            args = args.concat(ffmpegArgs[format]);
        }

         if (streamInfo.startTime) {
            args.push('-ss', streamInfo.startTime)
        }
        
        if (streamInfo.endTime) {
            args.push('-to', streamInfo.endTime)
        }

        if (hlsExceptions.includes(streamInfo.service) && streamInfo.isHLS) {
            if (streamInfo.service === "youtube" && format === "webm") {
                args.push('-c:a', 'libopus');
            } else {
                args.push('-c:a', 'aac', '-bsf:a', 'aac_adtstoasc');
            }
        }

        if (streamInfo.metadata) {
            args = args.concat(convertMetadataToFFmpeg(streamInfo.metadata))
        }

        args.push('-f', format, 'pipe:3');

        process = spawn(...getCommand(args), {
            windowsHide: true,
            stdio: [
                'inherit', 'inherit', 'inherit',
                'pipe'
            ],
        });

        const [,,, muxOutput] = process.stdio;

        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Content-Disposition', contentDisposition(streamInfo.filename));

        pipe(muxOutput, res, shutdown);

        process.on('close', shutdown);
        res.on('finish', shutdown);
    } catch {
        shutdown();
    }
}

const remux = (streamInfo, res) => {
    let process;
    const shutdown = () => (
        killProcess(process),
        closeResponse(res),
        destroyInternalStream(streamInfo.urls)
    );

    try {
        let args = [
            '-loglevel', '-8',
            '-headers', toRawHeaders(getHeaders(streamInfo.service)),
        ]

        if (streamInfo.service === "twitter") {
            args.push('-seekable', '0')
        }

        args.push(
            '-i', streamInfo.urls,
            '-c:v', 'copy',
        )

        if (streamInfo.startTime) {
            args.push('-ss', streamInfo.startTime)
        }
        
        if (streamInfo.endTime) {
            args.push('-to', streamInfo.endTime)
        }

        if (streamInfo.type === "mute") {
            args.push('-an');
        }

        if (hlsExceptions.includes(streamInfo.service)) {
            if (streamInfo.type !== "mute") {
                args.push('-c:a', 'aac')
            }
            args.push('-bsf:a', 'aac_adtstoasc');
        }

        let format = streamInfo.filename.split('.')[streamInfo.filename.split('.').length - 1];
        if (format === "mp4") {
            args.push('-movflags', 'faststart+frag_keyframe+empty_moov')
        }

        args.push('-f', format, 'pipe:3');

        process = spawn(...getCommand(args), {
            windowsHide: true,
            stdio: [
                'inherit', 'inherit', 'inherit',
                'pipe'
            ],
        });

        const [,,, muxOutput] = process.stdio;

        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Content-Disposition', contentDisposition(streamInfo.filename));

        pipe(muxOutput, res, shutdown);

        process.on('close', shutdown);
        res.on('finish', shutdown);
    } catch {
        shutdown();
    }
}

const convertAudio = (streamInfo, res) => {
    let process;
    const shutdown = () => (
        killProcess(process),
        closeResponse(res),
        destroyInternalStream(streamInfo.urls)
    );

    try {
        let args = [
            '-loglevel', '-8',
            '-headers', toRawHeaders(getHeaders(streamInfo.service)),
        ]

        if (streamInfo.service === "twitter") {
            args.push('-seekable', '0');
        }

        args.push(
            '-i', streamInfo.urls,
            '-vn'
        )

        if (streamInfo.startTime) {
            args.push('-ss', streamInfo.startTime)
        }
        
        if (streamInfo.endTime) {
            args.push('-to', streamInfo.endTime)
        }

        if (streamInfo.audioCopy) {
            args.push("-c:a", "copy")
        } else {
            args.push("-b:a", `${streamInfo.audioBitrate}k`)
        }

        if (streamInfo.audioFormat === "mp3" && streamInfo.audioBitrate === "8") {
            args.push("-ar", "12000");
        }

        if (streamInfo.audioFormat === "opus") {
            args.push("-vbr", "off")
        }

        if (ffmpegArgs[streamInfo.audioFormat]) {
            args = args.concat(ffmpegArgs[streamInfo.audioFormat])
        }

        if (streamInfo.metadata) {
            args = args.concat(convertMetadataToFFmpeg(streamInfo.metadata))
        }

        args.push('-f', streamInfo.audioFormat === "m4a" ? "ipod" : streamInfo.audioFormat, 'pipe:3');

        process = spawn(...getCommand(args), {
            windowsHide: true,
            stdio: [
                'inherit', 'inherit', 'inherit',
                'pipe'
            ],
        });

        const [,,, muxOutput] = process.stdio;

        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Content-Disposition', contentDisposition(streamInfo.filename));

        pipe(muxOutput, res, shutdown);
        res.on('finish', shutdown);
    } catch {
        shutdown();
    }
}

const convertGif = (streamInfo, res) => {
    let process;
    const shutdown = () => (killProcess(process), closeResponse(res));

    try {
        let args = [
            '-loglevel', '-8'
        ]

        if (streamInfo.service === "twitter") {
            args.push('-seekable', '0')
        }

        args.push('-i', streamInfo.urls);
        args = args.concat(ffmpegArgs.gif);
        args.push('-f', "gif", 'pipe:3');

        process = spawn(...getCommand(args), {
            windowsHide: true,
            stdio: [
                'inherit', 'inherit', 'inherit',
                'pipe'
            ],
        });

        const [,,, muxOutput] = process.stdio;

        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Content-Disposition', contentDisposition(streamInfo.filename));

        pipe(muxOutput, res, shutdown);

        process.on('close', shutdown);
        res.on('finish', shutdown);
    } catch {
        shutdown();
    }
}

export default {
    proxy,
    merge,
    remux,
    convertAudio,
    convertGif,
}
