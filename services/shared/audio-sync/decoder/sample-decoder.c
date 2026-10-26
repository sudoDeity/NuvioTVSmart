/* Audio analysis wrapper around FFmpeg 5.1.4 (LGPL-2.1-or-later).
 * No demuxer, CLI, virtual filesystem, encoder or playback state. */
#include <stdint.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include "libavcodec/avcodec.h"
#include "libavutil/channel_layout.h"
#include "libavutil/error.h"
#include "libavutil/log.h"
#include "libavutil/opt.h"
#include "libswresample/swresample.h"

#define INPUT_CAPACITY (4 * 1024 * 1024)
#define OUTPUT_SAMPLES (16000 * 30)
static uint8_t input[INPUT_CAPACITY + AV_INPUT_BUFFER_PADDING_SIZE];
static int16_t output[OUTPUT_SAMPLES];

EMSCRIPTEN_KEEPALIVE uint8_t *sample_input(void) { return input; }
EMSCRIPTEN_KEEPALIVE int16_t *sample_output(void) { return output; }

typedef struct {
    SwrContext *swr;
    AVChannelLayout layout;
    int rate, format;
} Converter;

static int receive(AVCodecContext *codec, AVFrame *frame, Converter *converter,
                   int *count, int limit) {
    int ret;
    while ((ret = avcodec_receive_frame(codec, frame)) >= 0) {
        if (converter->swr && (converter->rate != frame->sample_rate ||
            converter->format != frame->format ||
            av_channel_layout_compare(&converter->layout, &frame->ch_layout)))
            return AVERROR_INVALIDDATA;
        if (!converter->swr) {
            if ((ret = av_channel_layout_copy(&converter->layout, &frame->ch_layout)) < 0) return ret;
            converter->rate = frame->sample_rate;
            converter->format = frame->format;
            AVChannelLayout mono = AV_CHANNEL_LAYOUT_MONO;
            ret = swr_alloc_set_opts2(&converter->swr, &mono, AV_SAMPLE_FMT_S16, 16000,
                &frame->ch_layout, frame->format, frame->sample_rate, 0, NULL);
            if (ret < 0) return ret;
            av_opt_set_double(converter->swr, "rematrix_maxval", 1.0, 0);
            if ((ret = swr_init(converter->swr)) < 0) return ret;
        }
        uint8_t *destination = (uint8_t *)(output + *count);
        ret = swr_convert(converter->swr, &destination, limit - *count,
                          (const uint8_t **)frame->extended_data, frame->nb_samples);
        av_frame_unref(frame);
        if (ret < 0) return ret;
        *count += ret;
        if (*count >= limit) return 0;
    }
    return ret == AVERROR(EAGAIN) || ret == AVERROR_EOF ? 0 : ret;
}

/* Format ordinals are private to sample-worker.js: AAC, AC3, EAC3, DTS, TrueHD.
 * A positive return value is the actual number of mono samples, never padding.
 * On any failure no partial output is reported as successful evidence. */
EMSCRIPTEN_KEEPALIVE int sample_decode(int size, int format, int limit) {
    const enum AVCodecID ids[] = { AV_CODEC_ID_NONE, AV_CODEC_ID_AAC, AV_CODEC_ID_AC3,
        AV_CODEC_ID_EAC3, AV_CODEC_ID_DTS, AV_CODEC_ID_TRUEHD };
    AVCodecContext *codec = NULL;
    AVCodecParserContext *parser = NULL;
    AVPacket *packet = NULL;
    AVFrame *frame = NULL;
    Converter converter = {0};
    int ret = AVERROR_INVALIDDATA, count = 0, offset = 0, steps = 0, stalled = 0;
    const double deadline = emscripten_get_now() + 8000;
    if (size < 1 || size > INPUT_CAPACITY || format < 1 || format > 5 ||
        limit < 1 || limit > OUTPUT_SAMPLES) return ret;
    memset(input + size, 0, AV_INPUT_BUFFER_PADDING_SIZE);
    av_log_set_level(AV_LOG_QUIET);
    const AVCodec *decoder = avcodec_find_decoder(ids[format]);
    if (!decoder) goto done;
    codec = avcodec_alloc_context3(decoder);
    parser = av_parser_init(ids[format]);
    packet = av_packet_alloc();
    frame = av_frame_alloc();
    if (!codec || !parser || !packet || !frame) { ret = AVERROR(ENOMEM); goto done; }
    codec->thread_count = 1;
    codec->err_recognition = AV_EF_EXPLODE;
    if (format != 1) {
        // Some TrueHD stereo presentations contain only FL/FR, omitting speech
        // in the center. Keep the 5.1 presentation for subsequent mono mixing.
        ret = av_opt_set(codec->priv_data, "downmix", format == 5 ? "5.1(side)" : "stereo", 0);
        if (ret < 0) goto done;
    }
    if (format == 4 && (ret = av_opt_set_int(codec->priv_data, "core_only", 1, 0)) < 0) goto done;
    if ((ret = avcodec_open2(codec, decoder, NULL)) < 0) goto done;
    while (offset < size && count < limit) {
        if (++steps > 100000 || (!(steps & 31) && emscripten_get_now() > deadline)) {
            ret = AVERROR(ETIMEDOUT); goto done;
        }
        uint8_t *data = NULL;
        int length = 0;
        ret = av_parser_parse2(parser, codec, &data, &length, input + offset, size - offset,
                              AV_NOPTS_VALUE, AV_NOPTS_VALUE, 0);
        if (ret < 0) goto done;
        // MLP's first major-sync transition legitimately consumes zero bytes.
        if (!ret && !length) {
            if (++stalled > 4) { ret = AVERROR_INVALIDDATA; goto done; }
        } else stalled = 0;
        offset += ret;
        if (length) {
            packet->data = data;
            packet->size = length;
            if ((ret = avcodec_send_packet(codec, packet)) < 0) goto done;
            if ((ret = receive(codec, frame, &converter, &count, limit)) < 0) goto done;
        }
    }
    // Emit the last complete parser packet, then drain codec/resampler delay.
    if (count < limit) {
        uint8_t *data = NULL;
        int length = 0;
        if ((ret = av_parser_parse2(parser, codec, &data, &length, NULL, 0,
                                    AV_NOPTS_VALUE, AV_NOPTS_VALUE, 0)) < 0) goto done;
        if (length) {
            packet->data = data;
            packet->size = length;
            if ((ret = avcodec_send_packet(codec, packet)) < 0) goto done;
            if ((ret = receive(codec, frame, &converter, &count, limit)) < 0) goto done;
        }
    }
    if (count < limit) {
        if ((ret = avcodec_send_packet(codec, NULL)) < 0 && ret != AVERROR_EOF) goto done;
        if ((ret = receive(codec, frame, &converter, &count, limit)) < 0) goto done;
        if (converter.swr) {
            uint8_t *destination = (uint8_t *)(output + count);
            if ((ret = swr_convert(converter.swr, &destination, limit - count, NULL, 0)) < 0) goto done;
            count += ret;
        }
    }
    ret = count > 0 ? count : AVERROR_INVALIDDATA;
done:
    swr_free(&converter.swr);
    av_channel_layout_uninit(&converter.layout);
    av_frame_free(&frame);
    av_packet_free(&packet);
    av_parser_close(parser);
    avcodec_free_context(&codec);
    return ret;
}
