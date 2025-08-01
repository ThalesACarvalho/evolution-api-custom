import { InstanceDto } from '@api/dto/instance.dto';
import {
  SendAudioDto,
  SendButtonsDto,
  SendContactDto,
  SendListDto,
  SendLocationDto,
  SendMediaDto,
  SendPollDto,
  SendPtvDto,
  SendReactionDto,
  SendStatusDto,
  SendStickerDto,
  SendTemplateDto,
  SendTextDto,
} from '@api/dto/sendMessage.dto';
import { WAMonitoringService } from '@api/services/monitor.service';
import { BadRequestException } from '@exceptions';
import { isBase64, isURL } from 'class-validator';

function isEmoji(str: string) {
  if (str === '') return true;

  const emojiRegex =
    /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F680}-\u{1F6FF}]$/u;
  return emojiRegex.test(str);
}

export class SendMessageController {
  constructor(private readonly waMonitor: WAMonitoringService) {}

  /**
   * Validate that an instance is ready for message sending
   */
  private validateInstanceReady(instanceName: string): void {
    const instance = this.waMonitor.waInstances[instanceName];

    if (!instance) {
      throw new BadRequestException(
        `Instance "${instanceName}" not found. Please ensure the instance is created and connected.`,
      );
    }

    const connectionState = instance.connectionStatus?.state;

    if (connectionState !== 'open') {
      throw new BadRequestException(
        `Instance "${instanceName}" is not ready for message sending. ` +
          `Current state: ${connectionState || 'unknown'}. Please wait for the instance to connect.`,
      );
    }

    // Additional validation for critical properties
    if (!instance.client || !instance.instanceId) {
      throw new BadRequestException(
        `Instance "${instanceName}" is missing critical components. Please reconnect the instance.`,
      );
    }
  }

  public async sendTemplate({ instanceName }: InstanceDto, data: SendTemplateDto) {
    this.validateInstanceReady(instanceName);
    return await this.waMonitor.waInstances[instanceName].templateMessage(data);
  }

  public async sendText({ instanceName }: InstanceDto, data: SendTextDto) {
    this.validateInstanceReady(instanceName);
    return await this.waMonitor.waInstances[instanceName].textMessage(data);
  }

  public async sendMedia({ instanceName }: InstanceDto, data: SendMediaDto, file?: any) {
    this.validateInstanceReady(instanceName);

    if (isBase64(data?.media) && !data?.fileName && data?.mediatype === 'document') {
      throw new BadRequestException('For base64 the file name must be informed.');
    }

    if (file || isURL(data?.media) || isBase64(data?.media)) {
      return await this.waMonitor.waInstances[instanceName].mediaMessage(data, file);
    }
    throw new BadRequestException('Owned media must be a url or base64');
  }

  public async sendPtv({ instanceName }: InstanceDto, data: SendPtvDto, file?: any) {
    this.validateInstanceReady(instanceName);

    if (file || isURL(data?.video) || isBase64(data?.video)) {
      return await this.waMonitor.waInstances[instanceName].ptvMessage(data, file);
    }
    throw new BadRequestException('Owned media must be a url or base64');
  }

  public async sendSticker({ instanceName }: InstanceDto, data: SendStickerDto, file?: any) {
    this.validateInstanceReady(instanceName);

    if (file || isURL(data.sticker) || isBase64(data.sticker)) {
      return await this.waMonitor.waInstances[instanceName].mediaSticker(data, file);
    }
    throw new BadRequestException('Owned media must be a url or base64');
  }

  public async sendWhatsAppAudio({ instanceName }: InstanceDto, data: SendAudioDto, file?: any) {
    this.validateInstanceReady(instanceName);

    if (file?.buffer || isURL(data.audio) || isBase64(data.audio)) {
      // Si file existe y tiene buffer, o si es una URL o Base64, continúa
      return await this.waMonitor.waInstances[instanceName].audioWhatsapp(data, file);
    } else {
      console.error('El archivo no tiene buffer o el audio no es una URL o Base64 válida');
      throw new BadRequestException('Owned media must be a url, base64, or valid file with buffer');
    }
  }

  public async sendButtons({ instanceName }: InstanceDto, data: SendButtonsDto) {
    this.validateInstanceReady(instanceName);
    return await this.waMonitor.waInstances[instanceName].buttonMessage(data);
  }

  public async sendLocation({ instanceName }: InstanceDto, data: SendLocationDto) {
    this.validateInstanceReady(instanceName);
    return await this.waMonitor.waInstances[instanceName].locationMessage(data);
  }

  public async sendList({ instanceName }: InstanceDto, data: SendListDto) {
    this.validateInstanceReady(instanceName);
    return await this.waMonitor.waInstances[instanceName].listMessage(data);
  }

  public async sendContact({ instanceName }: InstanceDto, data: SendContactDto) {
    this.validateInstanceReady(instanceName);
    return await this.waMonitor.waInstances[instanceName].contactMessage(data);
  }

  public async sendReaction({ instanceName }: InstanceDto, data: SendReactionDto) {
    this.validateInstanceReady(instanceName);

    if (!isEmoji(data.reaction)) {
      throw new BadRequestException('Reaction must be a single emoji or empty string');
    }
    return await this.waMonitor.waInstances[instanceName].reactionMessage(data);
  }

  public async sendPoll({ instanceName }: InstanceDto, data: SendPollDto) {
    this.validateInstanceReady(instanceName);
    return await this.waMonitor.waInstances[instanceName].pollMessage(data);
  }

  public async sendStatus({ instanceName }: InstanceDto, data: SendStatusDto, file?: any) {
    this.validateInstanceReady(instanceName);
    return await this.waMonitor.waInstances[instanceName].statusMessage(data, file);
  }
}
